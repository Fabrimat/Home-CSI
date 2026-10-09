/*
 * mode_client.c - see mode_client.h.
 *
 * HTTP client shape deliberately mirrors main/ota.c's (build_url/open_client/
 * log_http_status): there is no shared "http helpers" module in this
 * codebase to factor either into, so this is a small, self-contained
 * duplication of that pattern rather than a dependency on ota.c's private
 * statics. The device-token derivation is NOT duplicated - it calls the same
 * shared components/csi_protocol/device_token.c ota.c uses, with the same
 * injected mbedTLS HMAC primitive.
 */

#include "mode_client.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/md.h"
#include "sdkconfig.h"

#include "csi_protocol/bw_budget.h"
#include "csi_protocol/device_token.h"
#include "csi_protocol/mode_policy.h"

#include "csi_capture.h"
#include "net_uplink.h"
#include "sounding.h"
#include "time_sync.h"
#include "wifi_link.h"

static const char *TAG = "mode_client";

#define MODE_TASK_PRIO 1
#define MODE_TASK_STACK 6144
#define MODE_URL_MAX (NODE_CFG_URL_MAX + 32)
#define MODE_BODY_MAX 512
/* How often the local-deadline check and the "is it time to poll yet" check
 * run. Independent of (and much finer-grained than) the - possibly much
 * longer - server-controlled poll interval, because the deadline must be
 * enforceable without ever talking to the server again. */
#define MODE_TICK_MS 1000

static node_config_t s_cfg; /* the NORMAL baseline this node reverts to */
static char s_auth[8 + HCS_DEVICE_TOKEN_LEN + 1];

static hcs_node_mode_t s_active_mode = HCS_NODE_MODE_NORMAL;
static bool s_have_active_revision;
static uint32_t s_active_revision;
static uint64_t s_deadline_mono_us;
static uint32_t s_poll_interval_s; /* 0 = use the Kconfig floor as bootstrap */
static uint32_t s_consecutive_failures;

/* --- crypto primitive, injected into the shared derivation -------------- */

/* Identical in shape and purpose to main/ota.c's hmac_sha256_mbedtls():
 * components/csi_protocol/device_token.c takes the HMAC primitive as a
 * parameter so it stays free of any ESP-IDF/mbedTLS dependency and can be
 * compiled by the host tests against a different (reference) primitive. */
static int hmac_sha256_mbedtls(void *ctx, const uint8_t *key, size_t key_len,
                               const uint8_t *msg, size_t msg_len,
                               uint8_t out[32])
{
    (void)ctx;
    const mbedtls_md_info_t *info =
        mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (info == NULL) {
        return -1;
    }
    return (mbedtls_md_hmac(info, key, key_len, msg, msg_len, out) == 0) ? 0
                                                                        : -1;
}

/* --- small HTTP helpers (mirrors main/ota.c's) --------------------------- */

static void build_url(char *out, size_t cap, const char *path)
{
    size_t n = strlen(s_cfg.api_base);
    while (n > 0 && s_cfg.api_base[n - 1u] == '/') {
        n--;
    }
    snprintf(out, cap, "%.*s%s", (int)n, s_cfg.api_base, path);
}

static esp_http_client_handle_t open_client(const char *url)
{
    const esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 15000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (c == NULL) {
        return NULL;
    }
    (void)esp_http_client_set_header(c, "Authorization", s_auth);
    return c;
}

static void log_http_status(int status)
{
    if (status == 401 || status == 403) {
        ESP_LOGE(TAG,
                 "mode poll rejected with HTTP %d. Same cause as an OTA "
                 "rejection: this node's device token and the server's "
                 "registry disagree (see main/ota.c's log line for the fix).",
                 status);
    } else {
        ESP_LOGW(TAG, "mode poll returned HTTP %d", status);
    }
}

/* --- GET /device/mode ----------------------------------------------------*/

/* 1 = a proposal was parsed into *out, 0 = nothing usable (network/HTTP
 * error, malformed body). Never returns a partially-filled *out. */
static int fetch_mode(hcs_mode_proposal_t *out)
{
    char url[MODE_URL_MAX];
    build_url(url, sizeof url, "/device/mode");

    esp_http_client_handle_t c = open_client(url);
    if (c == NULL) {
        return 0;
    }

    int ok = 0;
    char *body = NULL;
    cJSON *doc = NULL;

    esp_err_t err = esp_http_client_open(c, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "mode poll connect failed: %s (staying on the current "
                      "locally-enforced mode)",
                 esp_err_to_name(err));
        goto done;
    }
    (void)esp_http_client_fetch_headers(c);

    const int status = esp_http_client_get_status_code(c);
    if (status != 200) {
        log_http_status(status);
        goto done;
    }

    body = calloc(1, MODE_BODY_MAX);
    if (body == NULL) {
        goto done;
    }
    const int got = esp_http_client_read_response(c, body, MODE_BODY_MAX - 1);
    if (got <= 0) {
        ESP_LOGW(TAG, "mode poll: empty body");
        goto done;
    }
    body[got] = '\0';

    doc = cJSON_Parse(body);
    if (doc == NULL) {
        ESP_LOGW(TAG, "mode poll: response is not valid JSON");
        goto done;
    }

    memset(out, 0, sizeof(*out));

    const cJSON *jmode = cJSON_GetObjectItemCaseSensitive(doc, "mode");
    const cJSON *jrev = cJSON_GetObjectItemCaseSensitive(doc, "revision");
    const cJSON *jexp = cJSON_GetObjectItemCaseSensitive(doc, "expiresAt");
    const cJSON *jpoll = cJSON_GetObjectItemCaseSensitive(doc, "pollIntervalS");
    const cJSON *jsi =
        cJSON_GetObjectItemCaseSensitive(doc, "soundingIntervalMs");
    const cJSON *jsr = cJSON_GetObjectItemCaseSensitive(doc, "soundingRps");
    const cJSON *jfb = cJSON_GetObjectItemCaseSensitive(doc, "flushBudgetMs");
    const cJSON *jmb =
        cJSON_GetObjectItemCaseSensitive(doc, "maxRecordsPerBatch");

    if (!cJSON_IsString(jmode) || jmode->valuestring == NULL) {
        ESP_LOGW(TAG, "mode poll: 'mode' missing or not a string");
        goto done;
    }
    if (strcmp(jmode->valuestring, "realtime") == 0) {
        out->mode = HCS_NODE_MODE_REALTIME;
    } else if (strcmp(jmode->valuestring, "normal") == 0) {
        out->mode = HCS_NODE_MODE_NORMAL;
    } else {
        ESP_LOGW(TAG, "mode poll: unknown mode '%s' - treating as normal",
                 jmode->valuestring);
        out->mode = HCS_NODE_MODE_NORMAL;
    }

    out->revision = cJSON_IsNumber(jrev) ? (uint32_t)jrev->valuedouble : 0u;
    out->poll_interval_s = cJSON_IsNumber(jpoll) ? (uint32_t)jpoll->valuedouble : 0u;
    out->sounding_interval_ms =
        cJSON_IsNumber(jsi) ? (uint32_t)jsi->valuedouble : 0u;
    out->sounding_rps = cJSON_IsNumber(jsr) ? (uint32_t)jsr->valuedouble : 0u;
    out->flush_budget_ms = cJSON_IsNumber(jfb) ? (uint32_t)jfb->valuedouble : 0u;
    out->max_records_per_batch =
        cJSON_IsNumber(jmb) ? (uint32_t)jmb->valuedouble : 0u;

    if (cJSON_IsString(jexp) && jexp->valuestring != NULL) {
        uint64_t us = 0;
        if (hcs_iso8601_utc_to_unix_us(jexp->valuestring, &us)) {
            out->expires_at_wall_us = us;
            out->has_expires_at = true;
        } else {
            ESP_LOGW(TAG,
                     "mode poll: expiresAt '%s' could not be parsed - "
                     "refusing realtime mode (never accepted unbounded)",
                     jexp->valuestring);
            out->mode = HCS_NODE_MODE_NORMAL;
        }
    }

    if (out->mode == HCS_NODE_MODE_REALTIME && !out->has_expires_at) {
        /* A realtime directive with no parseable expiry is, by definition,
         * an unbounded one - and this client never accepts that shape,
         * regardless of what the rest of the payload says. See the header
         * comment on why a locally-enforced exit is not optional. */
        ESP_LOGW(TAG, "mode poll: server offered 'realtime' with no usable "
                      "expiresAt - refusing (unbounded burst mode is never "
                      "accepted)");
        out->mode = HCS_NODE_MODE_NORMAL;
    }

    ok = 1;

done:
    if (doc != NULL) {
        cJSON_Delete(doc);
    }
    free(body);
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return ok;
}

/* --- applying a clamped proposal ----------------------------------------- */

static void ceilings_from_kconfig(hcs_mode_ceilings_t *c)
{
    memset(c, 0, sizeof(*c));
    c->min_poll_interval_s = CONFIG_HCS_MODE_POLL_MIN_INTERVAL_S;
    c->min_sounding_interval_ms = CONFIG_HCS_REALTIME_MIN_SOUNDING_INTERVAL_MS;
    c->max_sounding_rps = CONFIG_HCS_REALTIME_MAX_SOUNDING_RPS;
    c->min_flush_budget_ms = CONFIG_HCS_REALTIME_MIN_FLUSH_BUDGET_MS;
    c->max_records_per_batch = CONFIG_HCS_REALTIME_MAX_RECORDS_PER_BATCH;
    c->max_duration_s = CONFIG_HCS_REALTIME_MAX_DURATION_S;
}

static void apply_normal(void)
{
    sounding_set_interval_ms(s_cfg.sounding_interval_ms);
    csi_capture_reconfigure_bw(&s_cfg.bw);
    net_uplink_reconfigure_batch((uint16_t)s_cfg.max_records_per_batch,
                                 s_cfg.flush_budget_ms);
    s_active_mode = HCS_NODE_MODE_NORMAL;
    s_have_active_revision = false;
}

static void apply_realtime(const hcs_mode_applied_t *a)
{
    /* Start from the normal baseline: only the sounding-class admission
     * rate changes. Foreign-class cap, overall byte cap and decimation
     * thresholds are left exactly as provisioned - /device/mode has no
     * knob for those, and there is no reason to invent one here. */
    bw_budget_cfg_t cfg = s_cfg.bw;
    cfg.cls[BW_CLASS_SOUNDING].records_per_sec = a->sounding_rps;
    cfg.cls[BW_CLASS_SOUNDING].burst_records = a->sounding_rps * 2u;

    sounding_set_interval_ms(a->sounding_interval_ms);
    csi_capture_reconfigure_bw(&cfg);
    net_uplink_reconfigure_batch((uint16_t)a->max_records_per_batch,
                                 a->flush_budget_ms);
    s_active_mode = HCS_NODE_MODE_REALTIME;
}

static void handle_proposal(const hcs_mode_proposal_t *p)
{
    hcs_mode_ceilings_t ceilings;
    ceilings_from_kconfig(&ceilings);

    hcs_mode_applied_t applied;
    hcs_mode_clamp(p, &ceilings, &applied);

    if (applied.clamped_poll_interval || applied.clamped_sounding_interval
        || applied.clamped_sounding_rps || applied.clamped_flush_budget
        || applied.clamped_max_records) {
        ESP_LOGW(TAG,
                 "GET /device/mode proposal exceeded a local ceiling and was "
                 "clamped: poll=%u(req %u)s sndms=%u(req %u) "
                 "sndrps=%u(req %u) flush=%u(req %u)ms maxrec=%u(req %u)",
                 (unsigned)applied.poll_interval_s,
                 (unsigned)p->poll_interval_s,
                 (unsigned)applied.sounding_interval_ms,
                 (unsigned)p->sounding_interval_ms,
                 (unsigned)applied.sounding_rps, (unsigned)p->sounding_rps,
                 (unsigned)applied.flush_budget_ms,
                 (unsigned)p->flush_budget_ms,
                 (unsigned)applied.max_records_per_batch,
                 (unsigned)p->max_records_per_batch);
    }

    s_poll_interval_s = applied.poll_interval_s;

    if (applied.mode == HCS_NODE_MODE_REALTIME) {
        /* A new activation is: coming from normal mode, or the server
         * offering a different `revision` than the one already active. The
         * SAME revision polled again is not re-armed - see mode_policy.h's
         * header comment on hcs_mode_deadline_mono_us() for why recomputing
         * an unchanged directive's deadline on every poll would defeat the
         * whole point of committing to one at apply time. */
        const bool is_new_activation = (s_active_mode != HCS_NODE_MODE_REALTIME)
                                       || !s_have_active_revision
                                       || applied.revision != s_active_revision;
        if (is_new_activation) {
            const uint64_t now_wall = time_sync_wall_clock_us();
            const uint64_t now_mono = (uint64_t)esp_timer_get_time();
            s_deadline_mono_us = hcs_mode_deadline_mono_us(
                now_wall, now_mono, applied.expires_at_wall_us,
                ceilings.max_duration_s);
            s_active_revision = applied.revision;
            s_have_active_revision = true;
            apply_realtime(&applied);

            const uint64_t window_s = (s_deadline_mono_us - now_mono) / 1000000ull;
            ESP_LOGW(TAG,
                     "REALTIME (burst) mode ACTIVE: revision=%u, local "
                     "deadline in %llu s (sounding every %u ms, %u rec/s, "
                     "batch <=%u/<=%u ms). Reverts to normal on this node's "
                     "own clock even if the server never answers again.",
                     (unsigned)applied.revision,
                     (unsigned long long)window_s,
                     (unsigned)applied.sounding_interval_ms,
                     (unsigned)applied.sounding_rps,
                     (unsigned)applied.max_records_per_batch,
                     (unsigned)applied.flush_budget_ms);
        }
    } else if (s_active_mode == HCS_NODE_MODE_REALTIME) {
        ESP_LOGI(TAG, "server directed normal mode - reverting now");
        apply_normal();
    }
}

/* --- local deadline, independent of polling ------------------------------ */

static void check_local_deadline(void)
{
    if (s_active_mode != HCS_NODE_MODE_REALTIME) {
        return;
    }
    const uint64_t now_mono = (uint64_t)esp_timer_get_time();
    if (hcs_mode_deadline_expired(s_deadline_mono_us, now_mono)) {
        ESP_LOGW(TAG,
                 "REALTIME (burst) mode window EXPIRED on this node's own "
                 "clock - reverting to normal. This happens whether or not "
                 "the server is reachable right now.");
        apply_normal();
    }
}

/* --- task ----------------------------------------------------------------*/

static void mode_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(CONFIG_HCS_MODE_POLL_MIN_INTERVAL_S * 1000));

    int64_t next_poll_us = 0;
    for (;;) {
        check_local_deadline();

        if (wifi_link_is_connected()) {
            const int64_t now = esp_timer_get_time();
            if (now >= next_poll_us) {
                const uint32_t interval_s =
                    (s_poll_interval_s != 0u)
                        ? s_poll_interval_s
                        : (uint32_t)CONFIG_HCS_MODE_POLL_MIN_INTERVAL_S;
                next_poll_us = now + (int64_t)interval_s * 1000000;

                hcs_mode_proposal_t proposal;
                if (fetch_mode(&proposal)) {
                    s_consecutive_failures = 0;
                    handle_proposal(&proposal);
                } else {
                    s_consecutive_failures++;
                }
            }
        }

        vTaskDelay(pdMS_TO_TICKS(MODE_TICK_MS));
    }
}

/* --- entry point ----------------------------------------------------------*/

esp_err_t mode_client_start(const node_config_t *cfg)
{
    if (cfg == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_cfg = *cfg;
    s_active_mode = HCS_NODE_MODE_NORMAL;
    s_have_active_revision = false;
    s_poll_interval_s = 0;
    s_consecutive_failures = 0;

    if (s_cfg.api_base[0] == '\0') {
        /* Same gate as OTA: no api_base means no device API to poll.
         * Capture and uplink are unaffected, and the node is (and can only
         * ever be, with no way to enter it) in normal mode. */
        ESP_LOGI(TAG, "mode client disabled: no 'api_base' in NVS");
        memset(s_cfg.psk, 0, sizeof s_cfg.psk);
        s_cfg.psk_present = false;
        return ESP_OK;
    }

    char token[HCS_DEVICE_TOKEN_BUF_LEN];
    if (s_cfg.psk_present
        && hcs_device_token_derive(token, sizeof token, s_cfg.psk,
                                   hmac_sha256_mbedtls, NULL)
               == HCS_OK) {
        snprintf(s_auth, sizeof s_auth, "Bearer %s", token);
        memset(token, 0, sizeof token);
    } else {
        ESP_LOGE(TAG, "could not derive the device token - mode client "
                      "disabled");
        memset(s_cfg.psk, 0, sizeof s_cfg.psk);
        s_cfg.psk_present = false;
        return ESP_OK;
    }
    /* The key itself is not needed past this point, same reasoning as
     * main/ota.c: only the derived token is. */
    memset(s_cfg.psk, 0, sizeof s_cfg.psk);
    s_cfg.psk_present = false;

    ESP_LOGI(TAG,
             "mode client via %s: polling /device/mode every >=%d s "
             "(realtime ceilings: sounding >=%d ms / <=%d rec/s, flush "
             ">=%d ms, batch <=%d, duration <=%d s)",
             s_cfg.api_base, CONFIG_HCS_MODE_POLL_MIN_INTERVAL_S,
             CONFIG_HCS_REALTIME_MIN_SOUNDING_INTERVAL_MS,
             CONFIG_HCS_REALTIME_MAX_SOUNDING_RPS,
             CONFIG_HCS_REALTIME_MIN_FLUSH_BUDGET_MS,
             CONFIG_HCS_REALTIME_MAX_RECORDS_PER_BATCH,
             CONFIG_HCS_REALTIME_MAX_DURATION_S);

    if (xTaskCreate(mode_task, "mode_client", MODE_TASK_STACK, NULL,
                    MODE_TASK_PRIO, NULL)
        != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
