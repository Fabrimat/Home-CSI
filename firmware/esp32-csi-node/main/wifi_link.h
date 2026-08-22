/*
 * wifi_link.h - STA association to the dedicated AP, on a pinned channel, at
 * 20 MHz, with power save OFF and promiscuous mode running alongside.
 *
 * This is the module where getting the ESP-IDF call ORDER wrong produces a
 * node that looks fine and quietly delivers no CSI, so the ordering is
 * spelled out in wifi_link.c and must not be rearranged casually.
 */
#ifndef HCS_WIFI_LINK_H
#define HCS_WIFI_LINK_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#include "node_config.h"

typedef enum {
    WIFI_LINK_IDLE = 0,
    WIFI_LINK_CONNECTING,
    WIFI_LINK_CONNECTED,   /* associated, no IP yet */
    WIFI_LINK_GOT_IP,      /* associated and routable */
    WIFI_LINK_DISCONNECTED /* was up, now retrying with backoff */
} wifi_link_state_t;

/* Brings up netif + event loop + Wi-Fi and starts connecting. Returns as soon
 * as the driver is started; association happens asynchronously so nothing
 * downstream blocks on the AP being reachable. */
esp_err_t wifi_link_start(const node_config_t *cfg);

wifi_link_state_t wifi_link_state(void);
bool wifi_link_is_connected(void);

/* Seconds since the link last left the connected state (0 while connected).
 * main.c uses this to decide when a reboot is the only remaining option. */
uint32_t wifi_link_down_seconds(void);

/* Live radio facts for the heartbeat (proto S10). Return 0 / safe values when
 * not associated rather than failing. */
int8_t wifi_link_rssi(void);
uint8_t wifi_link_channel(void);

/* Our own STA MAC and the AP's BSSID; csi_capture uses them to classify a
 * captured frame's source. bssid is all-zero until associated. */
void wifi_link_own_mac(uint8_t out[6]);
void wifi_link_ap_bssid(uint8_t out[6]);

/* Re-reads the operating channel and bandwidth from the driver and logs an
 * error if they are not the pinned values. Called periodically by main.c:
 * a channel drift silently destroys the whole mesh, so it must be visible. */
void wifi_link_verify_radio(void);

#endif /* HCS_WIFI_LINK_H */
