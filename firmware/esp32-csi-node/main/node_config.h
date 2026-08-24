/*
 * node_config.h - all per-node identity and settings, read from NVS.
 *
 * RULE: nothing that differs between nodes, and nothing secret, is ever
 * compiled into the image. node_id, the 32-byte PSK, the server address, the
 * device-API base URL, the Wi-Fi credentials and the MAC allowlist all come
 * from NVS, written at provisioning time by tools/provision.py. The Kconfig
 * values are a bench fallback only, and every field records which source won
 * so the boot log makes it obvious.
 */
#ifndef HCS_NODE_CONFIG_H
#define HCS_NODE_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "csi_protocol/bw_budget.h"
#include "csi_protocol/csi_wire.h"

#define NODE_CFG_NVS_NAMESPACE "homecsi"
#define NODE_CFG_MAX_ALLOWLIST 16
#define NODE_CFG_HOST_MAX 64
#define NODE_CFG_SSID_MAX 33
#define NODE_CFG_PASS_MAX 65
/* An https:// URL is longer than a bare hostname, so it gets its own bound. */
#define NODE_CFG_URL_MAX 128

typedef enum {
    CFG_SRC_MISSING = 0, /* neither NVS nor Kconfig supplied a value */
    CFG_SRC_NVS = 1,
    CFG_SRC_KCONFIG = 2
} cfg_source_t;

typedef struct {
    /* --- identity (must come from NVS in production) --- */
    uint16_t node_id;
    uint8_t psk[HCS_KEY_LEN];
    bool psk_present;

    /* --- network --- */
    char server_host[NODE_CFG_HOST_MAX];
    uint16_t server_port;
    char ap_ssid[NODE_CFG_SSID_MAX];
    char ap_password[NODE_CFG_PASS_MAX];
    uint8_t channel; /* pinned 2.4 GHz channel, must match the AP */
    char sntp_server[NODE_CFG_HOST_MAX];

    /* HTTPS base URL of the device API (OTA manifest/firmware and the hello
     * telemetry ping), e.g. "https://homecsi.example.com". This is a
     * DIFFERENT thing from server_host/server_port above, which is the UDP
     * CSI ingest target: one is a TLS web endpoint, the other a raw UDP
     * socket, and in a real deployment they are usually different ports and
     * may be different hosts.
     *
     * Empty is legal and means "OTA disabled". Boards provisioned before OTA
     * existed have no such NVS key, and they must keep capturing exactly as
     * before, so this is deliberately NOT part of
     * node_config_is_deployable(). */
    char api_base[NODE_CFG_URL_MAX];

    /* --- capture --- */
    uint32_t sounding_interval_ms;
    uint8_t sounding_jitter_pct;
    int8_t rssi_floor_dbm;
    bool allowlist_enforced;
    uint8_t allowlist[NODE_CFG_MAX_ALLOWLIST][6];
    uint8_t allowlist_len;

    /* --- uplink --- */
    uint16_t max_records_per_batch;
    uint32_t flush_budget_ms;
    uint32_t heartbeat_interval_ms;
    uint32_t reconnect_reboot_s;
    bw_budget_cfg_t bw;

    /* --- local debug mode --- */
    bool debug_uart;
    bool debug_udp;
    char debug_udp_host[NODE_CFG_HOST_MAX];
    uint16_t debug_udp_port;

    /* --- provenance, for the boot log --- */
    cfg_source_t src_node_id;
    cfg_source_t src_psk;
    cfg_source_t src_server;
    cfg_source_t src_api_base;
    cfg_source_t src_wifi;
    cfg_source_t src_channel;
    cfg_source_t src_allowlist;
} node_config_t;

/* Reads everything, applying Kconfig fallbacks where NVS is silent (and only
 * if CONFIG_HCS_ALLOW_KCONFIG_FALLBACK). Never fails on a missing key: the
 * caller inspects node_config_is_deployable() instead, so a half-provisioned
 * node still boots far enough to complain over UART and blink an error. */
esp_err_t node_config_load(node_config_t *cfg);

/* True when the node has everything it needs to legitimately send: a valid
 * node_id, a PSK, a server, and Wi-Fi credentials. */
bool node_config_is_deployable(const node_config_t *cfg, const char **why_not);

/* Logs the resolved configuration and, for each field, whether NVS or
 * Kconfig won. Secrets are never printed - only whether they are present and
 * a short fingerprint. */
void node_config_log(const node_config_t *cfg);

#endif /* HCS_NODE_CONFIG_H */
