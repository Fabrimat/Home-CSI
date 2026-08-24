/*
 * ota.c - see ota.h.
 *
 * ====================== THE NODE DECIDES, NOT THE SERVER =================
 * The server publishes one manifest per rollout group and filters nothing
 * except rollout membership. Every "should I actually take this?" rule lives
 * here, on the node, because the node is the only party that knows what it is
 * running and what has already failed on it:
 *
 *   1. 204 from the manifest endpoint -> nothing to do.
 *   2. manifest.version == the running version -> nothing to do.
 *   3. ANTI-FLAP: manifest.version == the version in the slot the BOOTLOADER
 *      already marked invalid -> refuse. See should_install().
 *   4. otherwise download, verify, install, reboot.
 *
 * ========================= ROLLBACK / HEALTH ============================
 * CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE is on, so a freshly installed image
 * boots in state PENDING_VERIFY and the bootloader reverts to the previous
 * slot on the next reboot unless the app confirms itself first. This module
 * confirms only after the node has associated to the AP AND put at least one
 * UDP heartbeat on the wire - i.e. after it has demonstrably done its actual
 * job. See confirm_health_if_pending() for why the HTTPS hello is
 * deliberately NOT part of that condition.
 *
 * ========================== WATCHDOG SAFETY =============================
 * sdkconfig.defaults sets CONFIG_ESP_TASK_WDT_PANIC=y with a 30 s timeout,
 * and a two-megabyte download over TLS on a 2.4 GHz link takes far longer
 * than 30 s. Two deliberate choices keep that from panicking the chip:
 *
 *   - This task does NOT subscribe to the task watchdog. A slow download is
 *     not a wedged node, and the WDT's job here is to catch a capture/uplink
 *     task that has stopped turning - which this task cannot cause.
 *   - It runs at priority OTA_TASK_PRIO (1), the same priority as the main
 *     task that runs main.c's supervisor loop - the task that DOES feed the
 *     watchdog - and below the uplink task (5) and the radio. On top of that
 *     it yields explicitly between every network chunk and every 64 kB of
 *     read-back hashing, so it cannot monopolise the CPU even against an
 *     equal-priority task. Raising this priority above 1 would let a long
 *     download starve the supervisor and reboot the node mid-update.
 *
 * ========================== IMAGE SIGNING ===============================
 * Firmware image signing is deliberately NOT in this round, and it is worth
 * being precise about why, because "signing is impossible here" would be
 * false. The follow-up path is entirely workable: sign the built .bin at
 * PUBLISH time with `espsecure.py sign_data --version 2 --keyfile
 * secure_boot_signing_key.pem`, and turn on
 * CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT +
 * CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT so the running app verifies
 * the signature before accepting an OTA image. That is post-build signing:
 * developers never hold the key, the build stays reproducible without it, and
 * serial flashing is unaffected (no secure boot, no eFuse burn, no bricking
 * risk). Until it is done, the trust in an image rests on TLS to a server we
 * authenticate by its certificate, plus the manifest hash cross-check below -
 * which is meaningfully weaker than a signature, and is stated as such in
 * firmware/README.md rather than glossed over.
 *
 * ================= WHY NOT esp_https_ota_finish() =======================
 * This module drives esp_ota_begin/write/end/set_boot_partition directly over
 * an esp_http_client read loop, rather than esp_https_ota(). Not preference:
 * esp_https_ota_finish() performs esp_ota_end() AND
 * esp_ota_set_boot_partition() in one call, and the SHA-256 read-back below
 * has to happen BETWEEN those two. esp_ota_end() is what flushes the final
 * unaligned bytes of the image to flash, so the read-back is only meaningful
 * after it; set_boot_partition() is the point of no return, so the read-back
 * is only useful before it. There is no way to get in between with the
 * esp_https_ota handle, which is opaque. The read loop below is the same
 * shape as esp_https_ota_perform()'s, chunk for chunk.
 * =========================================================================
 */

#include "ota.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h" /* esp_app_desc_t. Moved here in IDF v5.0; it was
                           * esp_app_format.h / esp_ota_ops.h before that. */
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/md.h" /* the generic mbedtls_md_* API rather than
                        * mbedtls_sha256_*: it has the same spelling in
                        * mbedTLS 2.x and 3.x, and IDF v5 point releases
                        * have moved between them. */
#include "sdkconfig.h"

#include "csi_protocol/device_token.h"

#include "app_version.h"
#include "boot_epoch.h"
#include "net_uplink.h"
#include "wifi_link.h"

static const char *TAG = "ota";

/* See the WATCHDOG SAFETY note at the top of this file before changing this. */
#define OTA_TASK_PRIO 1
/* TLS handshake + cJSON + esp_http_client all want stack. The ESP-IDF HTTPS
 * OTA examples use 8 kB for the same combination. */
#define OTA_TASK_STACK 8192

/* esp_app_desc_t.version is char[32] and is not guaranteed to be
 * NUL-terminated when it is exactly full, so every copy of it gets 33 bytes. */
#define OTA_VERSION_MAX 33
#define OTA_SHA256_LEN 32
#define OTA_URL_MAX (NODE_CFG_URL_MAX + 32)
/* Network read chunk. Bigger means fewer yields per megabyte; 2 kB keeps the
 * heap cost trivial and still only ~1000 iterations for a 2 MB image. */
#define OTA_CHUNK 2048
#define OTA_HTTP_TIMEOUT_MS 15000
/* Smallest thing that could conceivably be an ESP32 app image. A manifest
 * claiming less is a broken publish, not a firmware. */
#define OTA_MIN_IMAGE_BYTES 4096

typedef enum {
    OTA_ST_STARTING = 0,
    OTA_ST_UP_TO_DATE,
    OTA_ST_PENDING_VERIFY,
    OTA_ST_CONFIRMED,
    OTA_ST_ROLLED_BACK,
    OTA_ST_DOWNLOADING,
    OTA_ST_DOWNLOAD_FAILED,
    OTA_ST_INSTALLED_PENDING_REBOOT,
    OTA_ST_DISABLED
} ota_state_t;

/* These strings go on the wire to /device/hello, so they are contract, not
 * decoration. Keep them stable and keep them in enum order. */
static const char *const STATE_NAMES[] = {
    "starting",
    "up-to-date",
    "pending-verify",
    "confirmed",
    "rolled-back",
    "downloading",
    "download-failed",
    "installed-pending-reboot",
    "disabled",
};

typedef struct {
    char version[OTA_VERSION_MAX];
    size_t size_bytes;
    uint8_t sha256[OTA_SHA256_LEN];
} ota_manifest_t;

static node_config_t s_cfg;
static ota_state_t s_state = OTA_ST_STARTING;
static bool s_rollback_on_record;
static char s_bad_version[OTA_VERSION_MAX];
static uint32_t s_consecutive_failures;
/* "Bearer " + 43 characters + NUL. A credential, so it lives in RAM only and
 * is never logged. */
static char s_auth[8 + HCS_DEVICE_TOKEN_LEN + 1];

/* --- state ------------------------------------------------------------- */

const char *ota_state_str(void)
{
    /* A rollback on record is the single most operationally important fact
     * about a node during a staged rollout, so a routine "nothing to do" poll
     * must not overwrite it into looking healthy. Any genuine activity state
     * still wins, because that is newer news. */
    if (s_rollback_on_record
        && (s_state == OTA_ST_STARTING || s_state == OTA_ST_UP_TO_DATE
            || s_state == OTA_ST_CONFIRMED)) {
        return STATE_NAMES[OTA_ST_ROLLED_BACK];
    }
    return STATE_NAMES[s_state];
}

/* --- crypto primitives, injected into the shared derivation ------------ */

/* hcs_hmac_sha256_fn. The derivation itself lives in
 * components/csi_protocol/device_token.c, which the host tests compile too;
 * only this primitive differs between device and host. */
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

/* --- small helpers ----------------------------------------------------- */

static int hex_nibble(char c)
{
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

static bool parse_hex32(const char *hex, uint8_t out[OTA_SHA256_LEN])
{
    if (hex == NULL || strlen(hex) != (size_t)OTA_SHA256_LEN * 2u) {
        return false;
    }
    for (size_t i = 0; i < OTA_SHA256_LEN; i++) {
        const int hi = hex_nibble(hex[2 * i]);
        const int lo = hex_nibble(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) {
            return false;
        }
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}

/* Copies an esp_app_desc_t-style fixed char array out as a C string. */
static void copy_desc_version(char *dst, size_t dst_cap, const char *src,
                              size_t src_len)
{
    const size_t n = (src_len < dst_cap - 1u) ? src_len : dst_cap - 1u;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

/* api_base may or may not carry a trailing slash; both must work, because
 * this is typed into nodes.json by a human. */
static void build_url(char *out, size_t cap, const char *path)
{
    size_t n = strlen(s_cfg.api_base);
    while (n > 0 && s_cfg.api_base[n - 1u] == '/') {
        n--;
    }
    snprintf(out, cap, "%.*s%s", (int)n, s_cfg.api_base, path);
}

static esp_http_client_handle_t open_client(const char *url,
                                           esp_http_client_method_t method)
{
    const esp_http_client_config_t cfg = {
        .url = url,
        .method = method,
        .timeout_ms = OTA_HTTP_TIMEOUT_MS,
        /* Real certificate validation against the bundled Mozilla root store.
         * Without crt_bundle_attach, esp-tls would have no trust anchors and
         * the connection would simply fail - which is the right default, but
         * this is what makes it work rather than what makes it safe. */
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

static void log_http_status(const char *what, int status)
{
    if (status == 401 || status == 403) {
        /* Worth its own message: it means the token this node derives and the
         * token the server expects disagree, which is either a stale server
         * registry or a PSK that was rotated on one side only. */
        ESP_LOGE(TAG,
                 "%s rejected with HTTP %d. This node's bearer token is "
                 "derived from its NVS PSK; the server must know the same "
                 "PSK for this node_id. Re-run "
                 "`provision.py registry` and update the server config.",
                 what, status);
    } else {
        ESP_LOGW(TAG, "%s returned HTTP %d", what, status);
    }
}

/* --- POST /device/hello ------------------------------------------------ */

static void send_hello(void)
{
    char url[OTA_URL_MAX];
    build_url(url, sizeof url, "/device/hello");

    char body[224];
    const int n = snprintf(body, sizeof body,
                           "{\"fwVersion\":\"%s\",\"bootEpoch\":%u,"
                           "\"uptimeS\":%u,\"otaState\":\"%s\"}",
                           HCS_FW_VERSION_STR, (unsigned)boot_epoch_current(),
                           (unsigned)(esp_timer_get_time() / 1000000),
                           ota_state_str());
    if (n <= 0 || (size_t)n >= sizeof body) {
        ESP_LOGW(TAG, "hello body did not fit - skipping");
        return;
    }

    esp_http_client_handle_t c = open_client(url, HTTP_METHOD_POST);
    if (c == NULL) {
        return;
    }
    (void)esp_http_client_set_header(c, "Content-Type", "application/json");
    (void)esp_http_client_set_post_field(c, body, n);

    const esp_err_t err = esp_http_client_perform(c);
    if (err != ESP_OK) {
        /* Pure telemetry. Nothing in this firmware depends on the hello
         * succeeding - in particular NOT the rollback confirmation. */
        ESP_LOGW(TAG, "hello failed: %s (telemetry only, ignoring)",
                 esp_err_to_name(err));
    } else {
        const int status = esp_http_client_get_status_code(c);
        if (status / 100 != 2) {
            log_http_status("hello", status);
        } else {
            ESP_LOGD(TAG, "hello ok (state=%s)", ota_state_str());
        }
    }
    esp_http_client_cleanup(c);
}

/* --- GET /device/ota/manifest ------------------------------------------ */

/* 1 = a manifest was parsed, 0 = 204 "nothing for you", -1 = error. */
static int fetch_manifest(ota_manifest_t *out)
{
    char url[OTA_URL_MAX];
    build_url(url, sizeof url, "/device/ota/manifest");

    esp_http_client_handle_t c = open_client(url, HTTP_METHOD_GET);
    if (c == NULL) {
        return -1;
    }

    int rc = -1;
    char *body = NULL;
    cJSON *doc = NULL;

    esp_err_t err = esp_http_client_open(c, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "manifest connect failed: %s", esp_err_to_name(err));
        goto done;
    }
    (void)esp_http_client_fetch_headers(c);

    const int status = esp_http_client_get_status_code(c);
    if (status == 204) {
        ESP_LOGD(TAG, "manifest: 204, no image published for this node");
        rc = 0;
        goto done;
    }
    if (status != 200) {
        log_http_status("manifest", status);
        goto done;
    }

    /* The manifest is three short fields. Anything remotely large is not a
     * manifest, and reading it into a fixed buffer is the whole defence. */
    body = calloc(1, 1024);
    if (body == NULL) {
        goto done;
    }
    const int got = esp_http_client_read_response(c, body, 1023);
    if (got <= 0) {
        ESP_LOGW(TAG, "manifest body was empty");
        goto done;
    }
    body[got] = '\0';

    doc = cJSON_Parse(body);
    if (doc == NULL) {
        ESP_LOGW(TAG, "manifest is not valid JSON");
        goto done;
    }

    const cJSON *jver = cJSON_GetObjectItemCaseSensitive(doc, "version");
    const cJSON *jsize = cJSON_GetObjectItemCaseSensitive(doc, "sizeBytes");
    const cJSON *jsha = cJSON_GetObjectItemCaseSensitive(doc, "sha256");

    if (!cJSON_IsString(jver) || jver->valuestring == NULL
        || jver->valuestring[0] == '\0'
        || strlen(jver->valuestring) >= OTA_VERSION_MAX) {
        ESP_LOGW(TAG, "manifest 'version' missing, empty or longer than %d "
                      "characters (esp_app_desc_t.version is char[32], so a "
                      "longer version could never match a slot)",
                 OTA_VERSION_MAX - 1);
        goto done;
    }
    if (!cJSON_IsNumber(jsize) || jsize->valuedouble < OTA_MIN_IMAGE_BYTES
        || jsize->valuedouble > (double)UINT32_MAX) {
        ESP_LOGW(TAG, "manifest 'sizeBytes' missing or implausible");
        goto done;
    }
    if (!cJSON_IsString(jsha)
        || !parse_hex32(jsha->valuestring, out->sha256)) {
        ESP_LOGW(TAG, "manifest 'sha256' is not 64 hex characters");
        goto done;
    }

    snprintf(out->version, sizeof out->version, "%s", jver->valuestring);
    out->size_bytes = (size_t)jsize->valuedouble;
    rc = 1;

done:
    if (doc != NULL) {
        cJSON_Delete(doc);
    }
    free(body);
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return rc;
}

/* --- the update decision ---------------------------------------------- */

static bool should_install(const ota_manifest_t *m)
{
    if (strcmp(m->version, HCS_FW_VERSION_STR) == 0) {
        ESP_LOGD(TAG, "manifest offers %s, which is what we are running",
                 m->version);
        s_state = OTA_ST_UP_TO_DATE;
        return false;
    }

    /* ============================ ANTI-FLAP =============================
     * Refuse the version that is sitting in the slot the BOOTLOADER marked
     * invalid - i.e. the one this node already downloaded, booted, failed to
     * confirm, and was rolled back off.
     *
     * Without this check that node is in an infinite loop: the server's
     * manifest still advertises vN (the server has no idea the node hated
     * it), so the node downloads vN again, erases and rewrites 2 MB of flash,
     * boots it, fails its health checkpoint again, rolls back again, and
     * comes round for another go every check interval - forever. The
     * observable result is the worst kind: heartbeats keep arriving from the
     * rolled-back image, so the node looks alive, while it quietly burns
     * flash write cycles and never stabilises. Behind a wall.
     *
     * Clearing it is an operator action, and a deliberate one: publish a
     * DIFFERENT version. A rebuild of "the same version with the bug fixed"
     * will be refused, which is correct - the version string is the only
     * thing either side can compare. */
    if (s_bad_version[0] != '\0' && strcmp(m->version, s_bad_version) == 0) {
        ESP_LOGW(TAG,
                 "refusing manifest version '%s': this node already ran it "
                 "and the bootloader rolled it back. Publish a new version "
                 "number to retry. (anti-flap)",
                 m->version);
        return false;
    }

    return true;
}

/* --- SHA-256 read-back ------------------------------------------------- */

/* Hashes `len` bytes read back out of `part` and compares them to `want`.
 *
 * WHAT THIS CATCHES, precisely - because it is easy to oversell:
 *
 *   NOT transit corruption or tampering. TLS already covers the bytes between
 *   the server and here, and it does it better than a hash the same server
 *   handed us would.
 *
 *   NOT a corrupt or truncated image. esp_ota_end() has already run
 *   esp_image_verify() over what landed in flash, which checks the image's own
 *   appended checksum and SHA-256.
 *
 *   What it catches is an OPERATOR MISTAKE: a manifest.json and a .bin in the
 *   server's firmware directory that do not belong together. Copy in a new
 *   .bin without regenerating the manifest (or the reverse, or half a `scp`),
 *   and every check above still passes - the image is intact, it is just not
 *   the image the rollout says it is. The node would install a firmware
 *   version nobody chose, report a version that does not match the manifest,
 *   and confuse the rollout for as long as it takes someone to notice.
 *
 * Those two files are maintained by hand, so cross-checking them against each
 * other is worth reading the partition back once per install (about half a
 * second, once per update, versus a wrong image on a wall-mounted node). */
static bool verify_partition_sha256(const esp_partition_t *part, size_t len,
                                   const uint8_t want[OTA_SHA256_LEN],
                                   uint8_t *scratch, size_t scratch_len)
{
    const mbedtls_md_info_t *info =
        mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (info == NULL) {
        return false;
    }

    mbedtls_md_context_t md;
    mbedtls_md_init(&md);
    bool ok = (mbedtls_md_setup(&md, info, 0) == 0)
              && (mbedtls_md_starts(&md) == 0);

    size_t since_yield = 0;
    for (size_t off = 0; ok && off < len;) {
        const size_t n = (len - off < scratch_len) ? (len - off) : scratch_len;
        if (esp_partition_read(part, off, scratch, n) != ESP_OK) {
            ESP_LOGE(TAG, "read-back failed at offset %u", (unsigned)off);
            ok = false;
            break;
        }
        if (mbedtls_md_update(&md, scratch, n) != 0) {
            ok = false;
            break;
        }
        off += n;
        since_yield += n;
        /* Hashing two megabytes without a break would hold the CPU for long
         * enough to matter to the tasks the watchdog is watching. */
        if (since_yield >= 65536u) {
            since_yield = 0;
            vTaskDelay(1);
        }
    }

    uint8_t got[OTA_SHA256_LEN];
    if (ok) {
        ok = (mbedtls_md_finish(&md, got) == 0);
    }
    mbedtls_md_free(&md);
    if (!ok) {
        return false;
    }

    if (memcmp(got, want, OTA_SHA256_LEN) != 0) {
        ESP_LOGE(TAG,
                 "SHA-256 MISMATCH: the image in '%s' is not the one "
                 "manifest.json describes. Not switching the boot partition. "
                 "Check that the .bin and the manifest in the server's "
                 "firmware directory were published together.",
                 part->label);
        return false;
    }
    return true;
}

/* --- download and install ---------------------------------------------- */

static bool download_and_install(const ota_manifest_t *m)
{
    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (target == NULL) {
        ESP_LOGE(TAG, "no OTA slot available - is this image running from a "
                      "'factory' partition? See partitions.csv");
        return false;
    }
    if (m->size_bytes > target->size) {
        ESP_LOGE(TAG, "manifest image is %u bytes, slot '%s' holds %u",
                 (unsigned)m->size_bytes, target->label,
                 (unsigned)target->size);
        return false;
    }

    char url[OTA_URL_MAX];
    build_url(url, sizeof url, "/device/ota/firmware");

    uint8_t *buf = malloc(OTA_CHUNK);
    esp_http_client_handle_t c = open_client(url, HTTP_METHOD_GET);
    if (buf == NULL || c == NULL) {
        free(buf);
        if (c != NULL) {
            esp_http_client_cleanup(c);
        }
        ESP_LOGE(TAG, "out of memory starting the download");
        return false;
    }

    bool ok = false;
    bool ota_open = false;
    esp_ota_handle_t h = 0;
    size_t total = 0;

    esp_err_t err = esp_http_client_open(c, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "firmware connect failed: %s", esp_err_to_name(err));
        goto done;
    }
    (void)esp_http_client_fetch_headers(c);
    const int status = esp_http_client_get_status_code(c);
    if (status != 200) {
        log_http_status("firmware", status);
        goto done;
    }

    /* Passing the real size (rather than OTA_SIZE_UNKNOWN) means only the
     * sectors we are going to use get erased, and any attempt to write past
     * it is refused by esp_ota_write() rather than by us. */
    err = esp_ota_begin(target, m->size_bytes, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin: %s", esp_err_to_name(err));
        goto done;
    }
    ota_open = true;
    ESP_LOGI(TAG, "downloading %s (%u bytes) into '%s'", m->version,
             (unsigned)m->size_bytes, target->label);

    for (;;) {
        const int n = esp_http_client_read(c, (char *)buf, OTA_CHUNK);
        if (n < 0) {
            ESP_LOGW(TAG, "read error after %u bytes", (unsigned)total);
            goto done;
        }
        if (n == 0) {
            break; /* connection closed / body complete */
        }
        if (total + (size_t)n > m->size_bytes) {
            ESP_LOGE(TAG, "server sent more than the manifest's %u bytes",
                     (unsigned)m->size_bytes);
            goto done;
        }
        err = esp_ota_write(h, buf, (size_t)n);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_write: %s", esp_err_to_name(err));
            goto done;
        }
        total += (size_t)n;
        if (total == m->size_bytes) {
            /* We have exactly what the manifest promised. Stop here rather
             * than making one more read that would sit on the socket for the
             * full timeout if the server keeps the connection open. */
            break;
        }

        /* Yield between chunks. See the WATCHDOG SAFETY note at the top: this
         * is what keeps a multi-minute download from starving the supervisor
         * and the uplink task, which run at the same or higher priority but
         * still need the CPU to hand back. */
        vTaskDelay(1);
    }

    if (total != m->size_bytes) {
        ESP_LOGE(TAG, "got %u bytes, manifest said %u", (unsigned)total,
                 (unsigned)m->size_bytes);
        goto done;
    }

    /* esp_ota_end() flushes the last (possibly unaligned) bytes and runs
     * esp_image_verify() over the slot: the image's own structural checks. */
    err = esp_ota_end(h);
    ota_open = false;
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end: %s - the image did not validate",
                 esp_err_to_name(err));
        goto done;
    }

    /* THE READ-BACK, and it happens here on purpose: after esp_ota_end() (so
     * every byte is in flash) and before esp_ota_set_boot_partition() (so a
     * mismatch costs us nothing but a wasted download). Read the long comment
     * on verify_partition_sha256() for exactly what this does and does not
     * prove. */
    if (!verify_partition_sha256(target, m->size_bytes, m->sha256, buf,
                                 OTA_CHUNK)) {
        goto done;
    }

    err = esp_ota_set_boot_partition(target);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_set_boot_partition: %s", esp_err_to_name(err));
        goto done;
    }
    ok = true;

done:
    if (ota_open) {
        (void)esp_ota_abort(h);
    }
    free(buf);
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    return ok;
}

/* --- boot classification ---------------------------------------------- */

static void classify_boot(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (running != NULL) {
        ESP_LOGI(TAG, "running from '%s' at 0x%06x, version %s",
                 running->label, (unsigned)running->address,
                 HCS_FW_VERSION_STR);
        esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
        if (esp_ota_get_state_partition(running, &st) == ESP_OK
            && st == ESP_OTA_IMG_PENDING_VERIFY) {
            s_state = OTA_ST_PENDING_VERIFY;
            ESP_LOGW(TAG,
                     "this image is PENDING_VERIFY - it was just installed by "
                     "OTA. The bootloader will roll back to the previous slot "
                     "on the next reboot unless this node associates and "
                     "sends a heartbeat first.");
        }
    }

    /* The other half of the anti-flap rule: what did the bootloader already
     * reject? esp_ota_get_last_invalid_partition() is the only record of it,
     * and it survives reboots. */
    const esp_partition_t *bad = esp_ota_get_last_invalid_partition();
    if (bad != NULL && bad != running) {
        s_rollback_on_record = true;
        esp_app_desc_t d;
        if (esp_ota_get_partition_description(bad, &d) == ESP_OK) {
            copy_desc_version(s_bad_version, sizeof s_bad_version, d.version,
                              sizeof d.version);
            ESP_LOGW(TAG,
                     "slot '%s' holds version '%s', which the bootloader "
                     "marked INVALID (it failed its health checkpoint and was "
                     "rolled back). That version will not be downloaded "
                     "again.",
                     bad->label, s_bad_version);
        } else {
            ESP_LOGW(TAG,
                     "slot '%s' was marked INVALID by the bootloader but its "
                     "app descriptor could not be read, so its version is "
                     "unknown and the anti-flap check cannot match on it. "
                     "Watch for repeated downloads of the same version.",
                     bad->label);
        }
    }
}

/* --- health checkpoint ------------------------------------------------- */

static void confirm_health_if_pending(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
    if (running == NULL || esp_ota_get_state_partition(running, &st) != ESP_OK
        || st != ESP_OTA_IMG_PENDING_VERIFY) {
        /* Already confirmed, or not an OTA slot at all. Nothing to do, and no
         * otadata write - which also means no flash wear per boot. */
        return;
    }

    /* ======================== THE CHECKPOINT ==========================
     * Two conditions, both about the node's own job:
     *   - associated to the dedicated AP, and
     *   - at least one UDP HEARTBEAT accepted by the socket layer
     *     (docs/protocol.md S10).
     *
     * Together those exercise Wi-Fi, DHCP, DNS, the crypto and the uplink
     * path - i.e. everything that makes this a sensor rather than a heater.
     *
     * DELIBERATELY NOT INCLUDED: the HTTPS hello. If confirmation depended on
     * the device API, then one expired TLS certificate, one bad deploy of
     * that one HTTP service, or one DNS mistake would make every node in the
     * fleet decline to confirm - and roll back, on their next reboot, off
     * firmware that was working perfectly. A fleet-wide firmware revert
     * triggered by an unrelated web outage is a much worse failure than the
     * one rollback exists to prevent. So the checkpoint keys off the node's
     * job, never off the update infrastructure. */
    ESP_LOGW(TAG, "waiting for the health checkpoint (AP association + one "
                  "UDP heartbeat) before confirming this image");
    for (;;) {
        net_uplink_stats_t us;
        net_uplink_get_stats(&us);
        if (wifi_link_is_connected() && us.heartbeats_sent > 0) {
            break;
        }
        vTaskDelay(pdMS_TO_TICKS(1000));
    }

    const esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err == ESP_OK) {
        s_state = OTA_ST_CONFIRMED;
        ESP_LOGI(TAG, "health checkpoint passed - image confirmed, rollback "
                      "cancelled");
    } else {
        /* Leaving it PENDING_VERIFY is the safe outcome: the bootloader will
         * revert on the next reboot rather than keep an unconfirmable image. */
        ESP_LOGE(TAG,
                 "esp_ota_mark_app_valid_cancel_rollback: %s - this image "
                 "stays unconfirmed and will be rolled back on the next "
                 "reboot",
                 esp_err_to_name(err));
    }
}

/* --- task -------------------------------------------------------------- */

static void check_for_update(void)
{
    ota_manifest_t m;
    memset(&m, 0, sizeof m);

    const int rc = fetch_manifest(&m);
    if (rc < 0) {
        /* A manifest that could not be fetched is a network or server
         * problem, not a failed image, so the reported state is left alone -
         * only the backoff counter moves. */
        s_consecutive_failures++;
        return;
    }
    if (rc == 0) {
        s_consecutive_failures = 0;
        s_state = OTA_ST_UP_TO_DATE;
        return;
    }
    if (!should_install(&m)) {
        s_consecutive_failures = 0;
        return;
    }

    s_state = OTA_ST_DOWNLOADING;
    if (!download_and_install(&m)) {
        s_consecutive_failures++;
        s_state = OTA_ST_DOWNLOAD_FAILED;
        ESP_LOGW(TAG, "update to %s failed (%u in a row)", m.version,
                 (unsigned)s_consecutive_failures);
        return;
    }

    s_consecutive_failures = 0;
    s_state = OTA_ST_INSTALLED_PENDING_REBOOT;
    /* A rollback on record is no longer the latest news. */
    s_rollback_on_record = false;

    ESP_LOGW(TAG, "installed %s - rebooting into it now. It will run "
                  "unconfirmed until it associates and sends a heartbeat.",
             m.version);
    /* One last hello so a staged rollout can see the node take the image even
     * if it never comes back. Best effort, like every other hello. */
    send_hello();
    vTaskDelay(pdMS_TO_TICKS(500)); /* let the log drain */
    esp_restart();
}

static void ota_task(void *arg)
{
    (void)arg;

    /* First job, before any networking: confirm the running image if it is
     * waiting to be confirmed. This has to happen even when OTA is disabled,
     * because an image installed while api_base was set still needs
     * confirming after api_base is removed. */
    confirm_health_if_pending();

    if (s_cfg.api_base[0] == '\0') {
        /* Already logged once in ota_start(). Retire the task rather than
         * spin a loop that will never do anything - and hand its 8 kB stack
         * back to a firmware that would rather use it for CSI. */
        ESP_LOGI(TAG, "OTA task retiring (auto-update off)");
        vTaskDelete(NULL);
        return;
    }

    /* Settle before the first check: a node that has just booted has more
     * useful things to be doing, and an immediate check at power-on would
     * make a whole mesh hit the server at once after a power cut. */
    vTaskDelay(pdMS_TO_TICKS(CONFIG_HCS_OTA_START_DELAY_S * 1000));

    int64_t next_hello_us = 0;
    int64_t next_check_us = 0;

    for (;;) {
        const int64_t now = esp_timer_get_time();

        if (wifi_link_is_connected()) {
            if (now >= next_hello_us) {
                next_hello_us =
                    now + (int64_t)CONFIG_HCS_OTA_HELLO_INTERVAL_S * 1000000;
                send_hello();
            }
            if (now >= next_check_us) {
                /* Back off after repeated failures. Every attempt erases and
                 * rewrites the inactive slot, and retrying hourly forever
                 * against a server-side problem is just flash wear. */
                uint32_t shift = s_consecutive_failures;
                if (shift > 4u) {
                    shift = 4u;
                }
                next_check_us =
                    now + ((int64_t)CONFIG_HCS_OTA_CHECK_INTERVAL_S * 1000000
                           << shift);
                check_for_update(); /* may reboot and not return */
            }
        }

        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

/* --- entry point ------------------------------------------------------- */

esp_err_t ota_start(const node_config_t *cfg)
{
    if (cfg == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_cfg = *cfg;

    classify_boot();

    /* Derive the bearer token once. It is a one-way function of the PSK that
     * is already in NVS - no new secret, and nothing per-node in the image. */
    char token[HCS_DEVICE_TOKEN_BUF_LEN];
    if (s_cfg.psk_present
        && hcs_device_token_derive(token, sizeof token, s_cfg.psk,
                                   hmac_sha256_mbedtls, NULL)
               == HCS_OK) {
        snprintf(s_auth, sizeof s_auth, "Bearer %s", token);
        memset(token, 0, sizeof token);
    } else {
        ESP_LOGE(TAG, "could not derive the device token - disabling OTA");
        s_cfg.api_base[0] = '\0';
    }
    /* The key itself is not needed past this point - only the derived token
     * is. Do not leave another copy of it alive in this module's statics for
     * the lifetime of the node. */
    memset(s_cfg.psk, 0, sizeof s_cfg.psk);
    s_cfg.psk_present = false;

    /* One line, once, at boot. Not a warning loop and not a reason to refuse
     * to run: a node without OTA still captures and still uplinks, and every
     * board provisioned before this feature existed is in exactly this
     * state. */
    if (s_cfg.api_base[0] == '\0') {
        s_state = OTA_ST_DISABLED;
        ESP_LOGW(TAG,
                 "OTA auto-update DISABLED: no 'api_base' in NVS. Capture and "
                 "uplink are unaffected. To enable it, add api_base (the "
                 "HTTPS device-API base URL, e.g. https://homecsi.example.com "
                 "- not the UDP ingest host) to nodes.json and re-run "
                 "tools/provision.py build.");
    } else if (strncmp(s_cfg.api_base, "https://", 8) != 0) {
        /* Refusing plain HTTP here rather than trusting a Kconfig symbol: the
         * bearer token and the firmware image both cross this connection. */
        s_state = OTA_ST_DISABLED;
        ESP_LOGE(TAG,
                 "OTA auto-update DISABLED: api_base '%s' is not an https:// "
                 "URL. The device token and the firmware image both travel "
                 "over it, so plain HTTP is refused.",
                 s_cfg.api_base);
        s_cfg.api_base[0] = '\0';
    } else {
        ESP_LOGI(TAG,
                 "OTA auto-update via %s: hello every %d s, manifest check "
                 "every %d s (first check in %d s)",
                 s_cfg.api_base, CONFIG_HCS_OTA_HELLO_INTERVAL_S,
                 CONFIG_HCS_OTA_CHECK_INTERVAL_S,
                 CONFIG_HCS_OTA_START_DELAY_S);
    }

    if (xTaskCreate(ota_task, "ota", OTA_TASK_STACK, NULL, OTA_TASK_PRIO, NULL)
        != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
