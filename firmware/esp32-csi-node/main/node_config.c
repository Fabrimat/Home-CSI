/* node_config.c - see node_config.h. */

#include "node_config.h"

#include <string.h>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

static const char *TAG = "node_cfg";

/* NVS keys. NVS caps key names at 15 characters, hence the abbreviations.
 * tools/provision.py writes exactly these names - keep the two in sync. */
#define K_NODE_ID     "node_id"
#define K_PSK         "psk"
#define K_SRV_HOST    "srv_host"
#define K_SRV_PORT    "srv_port"
#define K_AP_SSID     "ap_ssid"
#define K_AP_PASS     "ap_pass"
#define K_CHANNEL     "channel"
#define K_SNTP        "sntp_srv"
#define K_API_BASE    "api_base"
#define K_SND_MS      "snd_ms"
#define K_SND_JIT     "snd_jit"
#define K_RSSI_FLOOR  "rssi_floor"
#define K_ALLOW       "allowlist"
#define K_ALLOW_ENF   "allow_enf"
#define K_BATCH_MAX   "batch_max"
#define K_FLUSH_MS    "flush_ms"
#define K_HB_MS       "hb_ms"
#define K_RECON_S     "recon_s"
#define K_BW_SND_RPS  "bw_snd_rps"
#define K_BW_FRN_RPS  "bw_frn_rps"
#define K_BW_BPS      "bw_bps"
#define K_DEC_FRN     "dec_frn"
#define K_DEC_SND     "dec_snd"
#define K_DEC_FULL    "dec_full"
#define K_DEC_DIV     "dec_div"
#define K_DBG_UART    "dbg_uart"
#define K_DBG_UDP     "dbg_udp"
#define K_DBG_HOST    "dbg_host"
#define K_DBG_PORT    "dbg_port"

#if CONFIG_HCS_ALLOW_KCONFIG_FALLBACK
#define FALLBACK_ALLOWED 1
#else
#define FALLBACK_ALLOWED 0
#endif

/* --- small NVS helpers; each returns true when NVS supplied the value --- */

static bool get_u8(nvs_handle_t h, const char *key, uint8_t *out)
{
    return nvs_get_u8(h, key, out) == ESP_OK;
}

static bool get_i8(nvs_handle_t h, const char *key, int8_t *out)
{
    return nvs_get_i8(h, key, out) == ESP_OK;
}

static bool get_u16(nvs_handle_t h, const char *key, uint16_t *out)
{
    return nvs_get_u16(h, key, out) == ESP_OK;
}

static bool get_u32(nvs_handle_t h, const char *key, uint32_t *out)
{
    return nvs_get_u32(h, key, out) == ESP_OK;
}

static bool get_str(nvs_handle_t h, const char *key, char *out, size_t cap)
{
    size_t len = cap;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) {
        return false;
    }
    out[cap - 1] = '\0';
    return out[0] != '\0';
}

static bool get_blob(nvs_handle_t h, const char *key, void *out, size_t want,
                     size_t *got)
{
    size_t len = want;
    if (nvs_get_blob(h, key, out, &len) != ESP_OK) {
        return false;
    }
    if (got) {
        *got = len;
    }
    return true;
}

/* --- hex helper for the Kconfig PSK fallback -------------------------- */

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

static bool parse_psk_hex(const char *hex, uint8_t out[HCS_KEY_LEN])
{
    if (hex == NULL || strlen(hex) != (size_t)HCS_KEY_LEN * 2u) {
        return false;
    }
    for (size_t i = 0; i < HCS_KEY_LEN; i++) {
        const int hi = hex_nibble(hex[2 * i]);
        const int lo = hex_nibble(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) {
            return false;
        }
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}

/* --- defaults ---------------------------------------------------------- */

static void apply_builtin_defaults(node_config_t *c)
{
    memset(c, 0, sizeof(*c));

    /* Non-secret operational defaults are always safe to compile in; they are
     * behaviour, not identity. */
    c->server_port = CONFIG_HCS_DEFAULT_SERVER_PORT;
    c->channel = CONFIG_HCS_DEFAULT_CHANNEL;
    c->sounding_interval_ms = CONFIG_HCS_SOUNDING_INTERVAL_MS;
    c->sounding_jitter_pct = CONFIG_HCS_SOUNDING_JITTER_PCT;
    c->rssi_floor_dbm = (int8_t)CONFIG_HCS_RSSI_FLOOR_DBM;
    c->allowlist_enforced =
#if CONFIG_HCS_MAC_ALLOWLIST_ENFORCED
        true;
#else
        false;
#endif
    c->max_records_per_batch = CONFIG_HCS_MAX_RECORDS_PER_BATCH;
    c->flush_budget_ms = CONFIG_HCS_FLUSH_BUDGET_MS;
    c->heartbeat_interval_ms = CONFIG_HCS_HEARTBEAT_INTERVAL_MS;
    c->reconnect_reboot_s = CONFIG_HCS_RECONNECT_REBOOT_S;
    strncpy(c->sntp_server, CONFIG_HCS_DEFAULT_SNTP_SERVER,
            sizeof(c->sntp_server) - 1);

    bw_budget_default_cfg(&c->bw);
    c->bw.cls[BW_CLASS_SOUNDING].records_per_sec = CONFIG_HCS_BW_SOUNDING_RPS;
    c->bw.cls[BW_CLASS_SOUNDING].burst_records = CONFIG_HCS_BW_SOUNDING_RPS * 2u;
    c->bw.cls[BW_CLASS_FOREIGN].records_per_sec = CONFIG_HCS_BW_FOREIGN_RPS;
    c->bw.cls[BW_CLASS_FOREIGN].burst_records = CONFIG_HCS_BW_FOREIGN_RPS * 4u;
    c->bw.bytes_per_sec = CONFIG_HCS_BW_BYTES_PER_SEC;
    c->bw.burst_bytes = CONFIG_HCS_BW_BYTES_PER_SEC * 2u;
    c->bw.decimate_start_pct[BW_CLASS_FOREIGN] =
        CONFIG_HCS_DECIMATE_FOREIGN_START_PCT;
    c->bw.decimate_start_pct[BW_CLASS_SOUNDING] =
        CONFIG_HCS_DECIMATE_SOUNDING_START_PCT;
    c->bw.decimate_full_pct = CONFIG_HCS_DECIMATE_FULL_PCT;
    c->bw.decimate_max_divisor = CONFIG_HCS_DECIMATE_MAX_DIVISOR;

#if CONFIG_HCS_DEBUG_UART
    c->debug_uart = true;
#endif
#if CONFIG_HCS_DEBUG_UDP
    c->debug_udp = true;
    strncpy(c->debug_udp_host, CONFIG_HCS_DEBUG_UDP_HOST,
            sizeof(c->debug_udp_host) - 1);
    c->debug_udp_port = CONFIG_HCS_DEBUG_UDP_PORT;
#endif
}

/* Identity/secret fields: Kconfig only fills them in when explicitly allowed,
 * and even then only if a value was actually configured. */
static void apply_identity_fallbacks(node_config_t *c)
{
    if (!FALLBACK_ALLOWED) {
        return;
    }
    if (c->src_node_id == CFG_SRC_MISSING && CONFIG_HCS_DEFAULT_NODE_ID != 0) {
        c->node_id = CONFIG_HCS_DEFAULT_NODE_ID;
        c->src_node_id = CFG_SRC_KCONFIG;
    }
    if (c->src_psk == CFG_SRC_MISSING
        && parse_psk_hex(CONFIG_HCS_DEFAULT_PSK_HEX, c->psk)) {
        c->psk_present = true;
        c->src_psk = CFG_SRC_KCONFIG;
    }
    if (c->src_server == CFG_SRC_MISSING
        && CONFIG_HCS_DEFAULT_SERVER_HOST[0] != '\0') {
        strncpy(c->server_host, CONFIG_HCS_DEFAULT_SERVER_HOST,
                sizeof(c->server_host) - 1);
        c->src_server = CFG_SRC_KCONFIG;
    }
    if (c->src_wifi == CFG_SRC_MISSING && CONFIG_HCS_DEFAULT_AP_SSID[0] != '\0') {
        strncpy(c->ap_ssid, CONFIG_HCS_DEFAULT_AP_SSID, sizeof(c->ap_ssid) - 1);
        strncpy(c->ap_password, CONFIG_HCS_DEFAULT_AP_PASSWORD,
                sizeof(c->ap_password) - 1);
        c->src_wifi = CFG_SRC_KCONFIG;
    }
    if (c->src_channel == CFG_SRC_MISSING) {
        c->src_channel = CFG_SRC_KCONFIG;
    }
}

esp_err_t node_config_load(node_config_t *cfg)
{
    if (cfg == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    apply_builtin_defaults(cfg);

    nvs_handle_t h;
    const esp_err_t err = nvs_open(NODE_CFG_NVS_NAMESPACE, NVS_READONLY, &h);
    if (err != ESP_OK) {
        ESP_LOGW(TAG,
                 "NVS namespace '%s' not present (%s) - this node has not "
                 "been provisioned; falling back to Kconfig where allowed",
                 NODE_CFG_NVS_NAMESPACE, esp_err_to_name(err));
        apply_identity_fallbacks(cfg);
        return ESP_OK;
    }

    if (get_u16(h, K_NODE_ID, &cfg->node_id) && cfg->node_id != 0) {
        cfg->src_node_id = CFG_SRC_NVS;
    }

    size_t psk_len = 0;
    if (get_blob(h, K_PSK, cfg->psk, sizeof(cfg->psk), &psk_len)
        && psk_len == HCS_KEY_LEN) {
        cfg->psk_present = true;
        cfg->src_psk = CFG_SRC_NVS;
    } else if (psk_len != 0 && psk_len != HCS_KEY_LEN) {
        ESP_LOGE(TAG, "NVS psk is %u bytes, expected %u - ignoring it",
                 (unsigned)psk_len, (unsigned)HCS_KEY_LEN);
        memset(cfg->psk, 0, sizeof(cfg->psk));
    }

    if (get_str(h, K_SRV_HOST, cfg->server_host, sizeof(cfg->server_host))) {
        cfg->src_server = CFG_SRC_NVS;
    }
    (void)get_u16(h, K_SRV_PORT, &cfg->server_port);

    if (get_str(h, K_AP_SSID, cfg->ap_ssid, sizeof(cfg->ap_ssid))) {
        cfg->src_wifi = CFG_SRC_NVS;
        /* An open network is legal, so an absent password is not an error. */
        (void)get_str(h, K_AP_PASS, cfg->ap_password, sizeof(cfg->ap_password));
    }

    if (get_u8(h, K_CHANNEL, &cfg->channel)) {
        cfg->src_channel = CFG_SRC_NVS;
    }
    (void)get_str(h, K_SNTP, cfg->sntp_server, sizeof(cfg->sntp_server));

    /* An absent api_base is NOT an error: it means OTA auto-update is off.
     * Every board provisioned before OTA existed lacks this key and must keep
     * capturing and uplinking exactly as before, so it is deliberately not
     * part of node_config_is_deployable(). See ota_start(). */
    if (get_str(h, K_API_BASE, cfg->api_base, sizeof(cfg->api_base))) {
        cfg->src_api_base = CFG_SRC_NVS;
    }

    (void)get_u32(h, K_SND_MS, &cfg->sounding_interval_ms);
    (void)get_u8(h, K_SND_JIT, &cfg->sounding_jitter_pct);
    (void)get_i8(h, K_RSSI_FLOOR, &cfg->rssi_floor_dbm);

    uint8_t allow_enf = 0;
    if (get_u8(h, K_ALLOW_ENF, &allow_enf)) {
        cfg->allowlist_enforced = (allow_enf != 0);
    }

    size_t allow_bytes = 0;
    if (get_blob(h, K_ALLOW, cfg->allowlist, sizeof(cfg->allowlist),
                 &allow_bytes)
        && (allow_bytes % 6u) == 0u) {
        cfg->allowlist_len = (uint8_t)(allow_bytes / 6u);
        cfg->src_allowlist = CFG_SRC_NVS;
    }

    (void)get_u16(h, K_BATCH_MAX, &cfg->max_records_per_batch);
    (void)get_u32(h, K_FLUSH_MS, &cfg->flush_budget_ms);
    (void)get_u32(h, K_HB_MS, &cfg->heartbeat_interval_ms);
    (void)get_u32(h, K_RECON_S, &cfg->reconnect_reboot_s);

    (void)get_u32(h, K_BW_SND_RPS, &cfg->bw.cls[BW_CLASS_SOUNDING].records_per_sec);
    (void)get_u32(h, K_BW_FRN_RPS, &cfg->bw.cls[BW_CLASS_FOREIGN].records_per_sec);
    (void)get_u32(h, K_BW_BPS, &cfg->bw.bytes_per_sec);
    (void)get_u8(h, K_DEC_FRN, &cfg->bw.decimate_start_pct[BW_CLASS_FOREIGN]);
    (void)get_u8(h, K_DEC_SND, &cfg->bw.decimate_start_pct[BW_CLASS_SOUNDING]);
    (void)get_u8(h, K_DEC_FULL, &cfg->bw.decimate_full_pct);
    (void)get_u8(h, K_DEC_DIV, &cfg->bw.decimate_max_divisor);

    uint8_t flag = 0;
    if (get_u8(h, K_DBG_UART, &flag)) {
        cfg->debug_uart = (flag != 0);
    }
    if (get_u8(h, K_DBG_UDP, &flag)) {
        cfg->debug_udp = (flag != 0);
    }
    (void)get_str(h, K_DBG_HOST, cfg->debug_udp_host,
                  sizeof(cfg->debug_udp_host));
    (void)get_u16(h, K_DBG_PORT, &cfg->debug_udp_port);

    nvs_close(h);

    apply_identity_fallbacks(cfg);

    /* Derived burst depths follow whatever rate ended up configured. */
    cfg->bw.cls[BW_CLASS_SOUNDING].burst_records =
        cfg->bw.cls[BW_CLASS_SOUNDING].records_per_sec * 2u;
    cfg->bw.cls[BW_CLASS_FOREIGN].burst_records =
        cfg->bw.cls[BW_CLASS_FOREIGN].records_per_sec * 4u;
    cfg->bw.burst_bytes = cfg->bw.bytes_per_sec * 2u;

    return ESP_OK;
}

bool node_config_is_deployable(const node_config_t *cfg, const char **why_not)
{
    const char *reason = NULL;
    if (cfg == NULL) {
        reason = "no config";
    } else if (cfg->node_id == 0) {
        reason = "node_id is unset (0 is reserved/invalid)";
    } else if (!cfg->psk_present) {
        reason = "no 32-byte PSK provisioned";
    } else if (cfg->server_host[0] == '\0') {
        reason = "no ingest server host";
    } else if (cfg->ap_ssid[0] == '\0') {
        reason = "no dedicated-AP SSID";
    } else if (cfg->channel < 1 || cfg->channel > 14) {
        reason = "channel outside 1-14";
    }
    if (why_not) {
        *why_not = reason;
    }
    return reason == NULL;
}

static const char *src_name(cfg_source_t s)
{
    switch (s) {
    case CFG_SRC_NVS:
        return "NVS";
    case CFG_SRC_KCONFIG:
        return "Kconfig";
    default:
        return "MISSING";
    }
}

void node_config_log(const node_config_t *cfg)
{
    if (cfg == NULL) {
        return;
    }
    ESP_LOGI(TAG, "----- resolved node configuration -----");
    ESP_LOGI(TAG, "  node_id        = %u        [%s]", (unsigned)cfg->node_id,
             src_name(cfg->src_node_id));
    if (cfg->psk_present) {
        /* Never log a key. The first and last byte is enough to tell two
         * provisioned nodes apart in a log without being useful to anyone. */
        ESP_LOGI(TAG, "  psk            = present (%02x..%02x)  [%s]",
                 cfg->psk[0], cfg->psk[HCS_KEY_LEN - 1], src_name(cfg->src_psk));
    } else {
        ESP_LOGE(TAG, "  psk            = ABSENT   [%s]", src_name(cfg->src_psk));
    }
    ESP_LOGI(TAG, "  server         = %s:%u    [%s]", cfg->server_host,
             (unsigned)cfg->server_port, src_name(cfg->src_server));
    ESP_LOGI(TAG, "  ap_ssid        = '%s' (password %s)  [%s]", cfg->ap_ssid,
             cfg->ap_password[0] ? "set" : "empty/open", src_name(cfg->src_wifi));
    ESP_LOGI(TAG, "  channel        = %u        [%s]", (unsigned)cfg->channel,
             src_name(cfg->src_channel));
    ESP_LOGI(TAG, "  sntp           = %s", cfg->sntp_server);
    if (cfg->api_base[0] != '\0') {
        ESP_LOGI(TAG, "  api_base       = %s    [%s]", cfg->api_base,
                 src_name(cfg->src_api_base));
    } else {
        /* Info, not warning: a node without OTA is a completely functional
         * node, and this line must not read like a fault. */
        ESP_LOGI(TAG, "  api_base       = (unset) - OTA auto-update off, "
                      "capture and uplink unaffected  [%s]",
                 src_name(cfg->src_api_base));
    }
    ESP_LOGI(TAG, "  sounding       = every %u ms +/- %u%%",
             (unsigned)cfg->sounding_interval_ms,
             (unsigned)cfg->sounding_jitter_pct);
    ESP_LOGI(TAG, "  rssi floor     = %d dBm", (int)cfg->rssi_floor_dbm);
    ESP_LOGI(TAG, "  allowlist      = %u entries, %s  [%s]",
             (unsigned)cfg->allowlist_len,
             cfg->allowlist_enforced ? "ENFORCED" : "advisory",
             src_name(cfg->src_allowlist));
    for (uint8_t i = 0; i < cfg->allowlist_len; i++) {
        ESP_LOGI(TAG, "      [%u] %02x:%02x:%02x:%02x:%02x:%02x", i,
                 cfg->allowlist[i][0], cfg->allowlist[i][1],
                 cfg->allowlist[i][2], cfg->allowlist[i][3],
                 cfg->allowlist[i][4], cfg->allowlist[i][5]);
    }
    ESP_LOGI(TAG, "  batch          = <=%u records, <=%u ms",
             (unsigned)cfg->max_records_per_batch,
             (unsigned)cfg->flush_budget_ms);
    ESP_LOGI(TAG, "  heartbeat      = every %u ms",
             (unsigned)cfg->heartbeat_interval_ms);
    ESP_LOGI(TAG, "  budget         = sounding %u rec/s, foreign %u rec/s, "
                  "%u B/s",
             (unsigned)cfg->bw.cls[BW_CLASS_SOUNDING].records_per_sec,
             (unsigned)cfg->bw.cls[BW_CLASS_FOREIGN].records_per_sec,
             (unsigned)cfg->bw.bytes_per_sec);
    ESP_LOGI(TAG, "  decimation     = foreign>%u%%, sounding>%u%%, full@%u%%, "
                  "max 1-in-%u",
             (unsigned)cfg->bw.decimate_start_pct[BW_CLASS_FOREIGN],
             (unsigned)cfg->bw.decimate_start_pct[BW_CLASS_SOUNDING],
             (unsigned)cfg->bw.decimate_full_pct,
             (unsigned)cfg->bw.decimate_max_divisor);
    if (cfg->debug_uart || cfg->debug_udp) {
        ESP_LOGW(TAG, "  DEBUG MODE     = uart:%d udp:%d -> %s:%u  "
                      "(udp mirror is PLAINTEXT - never leave this on)",
                 (int)cfg->debug_uart, (int)cfg->debug_udp, cfg->debug_udp_host,
                 (unsigned)cfg->debug_udp_port);
    }
    ESP_LOGI(TAG, "---------------------------------------");
}
