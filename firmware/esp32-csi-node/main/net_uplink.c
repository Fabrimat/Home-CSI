/* net_uplink.c - see net_uplink.h. */

#include "net_uplink.h"

#include <errno.h>
#include <stdbool.h>
#include <string.h>

#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"

#include "csi_protocol/csi_batcher.h"
#include "csi_protocol/csi_codec.h"
#include "csi_protocol/csi_ring.h"
#include "csi_protocol/seq_epoch.h"

#include "crypto.h"
#include "csi_capture.h"
#include "heartbeat.h"
#include "status_led.h"
#include "time_sync.h"
#include "wifi_link.h"

static const char *TAG = "uplink";

/* 6 kB: the batcher (1156 B) and the datagram buffer (1200 B) are statics,
 * not stack, but mbedTLS and lwIP both want room. Explicit, not guessed at
 * by a default. */
#define UPLINK_TASK_STACK 6144
/* Above the LED (1) and sounding (3) tasks, below the Wi-Fi task (23) and
 * lwIP (18): the radio must always win. */
#define UPLINK_TASK_PRIO 5

#define UPLINK_POLL_MS 10
#define SEND_BACKOFF_MIN_MS 250u
#define SEND_BACKOFF_MAX_MS 30000u

static node_config_t s_cfg;
static net_uplink_stats_t s_stats;
static hcs_seq_t s_seq;
static hcs_crypto_t s_crypto;
static csi_batcher_t s_batcher;
static volatile bool s_has_sent;

static int s_sock = -1;
static int s_debug_sock = -1;
static int64_t s_next_send_attempt_us;
static uint32_t s_send_backoff_ms = SEND_BACKOFF_MIN_MS;

/* Static, because 1200 bytes of datagram on a 6 kB task stack is careless. */
static uint8_t s_datagram[HCS_MAX_DATAGRAM_LEN];

/* --- socket management ------------------------------------------------- */

static void close_socket(void)
{
    if (s_sock >= 0) {
        close(s_sock);
        s_sock = -1;
    }
}

/* Resolves and connect()s a UDP socket, per proto S1: connecting fixes the
 * destination and lets the stack drop unrelated inbound traffic, and the node
 * never listens. Returns false on any failure (the caller backs off). */
static bool open_socket(void)
{
    close_socket();

    char port_str[8];
    snprintf(port_str, sizeof port_str, "%u", (unsigned)s_cfg.server_port);

    struct addrinfo hints;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC; /* the VPS may be v4 or v6 */
    hints.ai_socktype = SOCK_DGRAM;

    struct addrinfo *res = NULL;
    const int rc = getaddrinfo(s_cfg.server_host, port_str, &hints, &res);
    if (rc != 0 || res == NULL) {
        s_stats.resolve_failures++;
        ESP_LOGW(TAG, "cannot resolve %s (rc=%d) - will retry with backoff",
                 s_cfg.server_host, rc);
        return false;
    }

    bool ok = false;
    for (struct addrinfo *ai = res; ai != NULL; ai = ai->ai_next) {
        const int fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) {
            continue;
        }
        struct timeval tv = { .tv_sec = 0, .tv_usec = 200000 }; /* 200 ms */
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) {
            s_sock = fd;
            ok = true;
            break;
        }
        close(fd);
    }
    freeaddrinfo(res);

    if (ok) {
        ESP_LOGI(TAG, "uplink socket connected to %s:%u", s_cfg.server_host,
                 (unsigned)s_cfg.server_port);
    } else {
        s_stats.resolve_failures++;
        ESP_LOGW(TAG, "could not connect a UDP socket to %s:%u",
                 s_cfg.server_host, (unsigned)s_cfg.server_port);
    }
    return ok;
}

static void open_debug_socket(void)
{
    if (!s_cfg.debug_udp || s_cfg.debug_udp_host[0] == '\0') {
        return;
    }
    char port_str[8];
    snprintf(port_str, sizeof port_str, "%u", (unsigned)s_cfg.debug_udp_port);
    struct addrinfo hints;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_DGRAM;
    struct addrinfo *res = NULL;
    if (getaddrinfo(s_cfg.debug_udp_host, port_str, &hints, &res) != 0
        || res == NULL) {
        ESP_LOGW(TAG, "debug mirror: cannot resolve %s", s_cfg.debug_udp_host);
        return;
    }
    const int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd >= 0 && connect(fd, res->ai_addr, res->ai_addrlen) == 0) {
        s_debug_sock = fd;
        ESP_LOGW(TAG,
                 "DEBUG MIRROR ACTIVE -> %s:%u. This sends UNENCRYPTED batch "
                 "plaintext on your LAN. Never ship a node like this.",
                 s_cfg.debug_udp_host, (unsigned)s_cfg.debug_udp_port);
    } else if (fd >= 0) {
        close(fd);
    }
    freeaddrinfo(res);
}

/* --- sending ----------------------------------------------------------- */

static bool send_datagram(const uint8_t *buf, size_t len)
{
    const int64_t now = esp_timer_get_time();
    if (now < s_next_send_attempt_us) {
        return false; /* still backing off; caller counts nothing */
    }
    if (!wifi_link_is_connected()) {
        return false;
    }
    if (s_sock < 0 && !open_socket()) {
        s_next_send_attempt_us = now + (int64_t)s_send_backoff_ms * 1000;
        s_send_backoff_ms = (s_send_backoff_ms >= SEND_BACKOFF_MAX_MS / 2u)
                                ? SEND_BACKOFF_MAX_MS
                                : s_send_backoff_ms * 2u;
        return false;
    }

    const int n = send(s_sock, buf, len, 0);
    if (n == (int)len) {
        s_send_backoff_ms = SEND_BACKOFF_MIN_MS;
        s_has_sent = true;
        return true;
    }

    s_stats.send_failures++;
    if ((s_stats.send_failures % 50u) == 1u) {
        ESP_LOGW(TAG, "send failed (errno %d, %u failures) - backing off",
                 errno, (unsigned)s_stats.send_failures);
    }
    /* A route change or an AP bounce leaves a stale socket behind; drop it so
     * the next attempt re-resolves. Transient network loss must never wedge
     * the task. */
    close_socket();
    s_next_send_attempt_us = now + (int64_t)s_send_backoff_ms * 1000;
    s_send_backoff_ms = (s_send_backoff_ms >= SEND_BACKOFF_MAX_MS / 2u)
                            ? SEND_BACKOFF_MAX_MS
                            : s_send_backoff_ms * 2u;
    return false;
}

/* Seals `plaintext` under a freshly allocated seq and sends it. */
static bool seal_and_send(uint8_t msg_type, const uint8_t *plaintext,
                          size_t pt_len)
{
    hcs_header_t hdr;
    const hcs_err_t serr = hcs_seq_next(&s_seq, msg_type, &hdr);
    if (serr == HCS_ERR_EXHAUSTED) {
        /* Structural nonce-uniqueness guarantee: never wrap. main.c watches
         * this counter and reboots, which allocates a fresh boot_epoch. */
        if (s_stats.seq_exhausted == 0) {
            ESP_LOGE(TAG, "sequence space exhausted - refusing to send until "
                          "reboot (a wrap would reuse an AEAD nonce)");
        }
        s_stats.seq_exhausted++;
        return false;
    }
    if (serr != HCS_OK) {
        return false;
    }

    size_t dg_len = 0;
    const hcs_err_t err =
        hcs_datagram_seal(s_datagram, sizeof s_datagram, &dg_len, &hdr,
                          plaintext, pt_len, s_cfg.psk, hcs_crypto_seal,
                          &s_crypto);
    if (err != HCS_OK) {
        s_stats.seal_failures++;
        ESP_LOGE(TAG, "seal failed (%d) for msg_type %u", (int)err,
                 (unsigned)msg_type);
        return false;
    }

    return send_datagram(s_datagram, dg_len);
}

/* --- local debug sinks -------------------------------------------------- */

static void debug_emit(const csi_ring_slot_t *slot)
{
    if (!s_cfg.debug_uart) {
        return;
    }
    const csi_ring_meta_t *m = &slot->meta;
    ESP_LOGI(TAG,
             "CSI src=%02x:%02x:%02x:%02x:%02x:%02x rssi=%d ch=%u sig=%u "
             "mcs=%u fmt=%u len=%u cls=%u first=[%d,%d,%d,%d]",
             m->src_mac[0], m->src_mac[1], m->src_mac[2], m->src_mac[3],
             m->src_mac[4], m->src_mac[5], (int)m->rssi, (unsigned)m->channel,
             (unsigned)m->sig_mode, (unsigned)m->mcs, (unsigned)m->csi_format,
             (unsigned)m->csi_len, (unsigned)m->source_class,
             (int)(int8_t)slot->data[0], (int)(int8_t)slot->data[1],
             (int)(int8_t)slot->data[2], (int)(int8_t)slot->data[3]);
}

static void debug_mirror_plaintext(const uint8_t *pt, size_t len)
{
    if (s_debug_sock >= 0) {
        (void)send(s_debug_sock, pt, len, 0);
    }
}

/* --- batching ----------------------------------------------------------- */

static void flush_batch(void)
{
    if (csi_batcher_is_empty(&s_batcher)) {
        return;
    }
    const uint8_t *pt = NULL;
    const size_t pt_len =
        csi_batcher_finalize(&s_batcher, time_sync_wall_clock_us(),
                             time_sync_mono_us(), time_sync_is_synced(), &pt);
    if (pt_len == 0) {
        csi_batcher_reset(&s_batcher);
        return;
    }

    debug_mirror_plaintext(pt, pt_len);

    if (seal_and_send(HCS_MSG_CSI_BATCH, pt, pt_len)) {
        s_stats.batches_sent++;
        status_led_blip();
    }
    /* Reset regardless: v1 has no retransmission (proto S1 - the node drops
     * rather than queues indefinitely). Holding a failed batch would stall
     * the ring and turn one lost datagram into a cascade. */
    csi_batcher_reset(&s_batcher);
}

/* Moves one slot out of the ring and into the batch. Returns false when the
 * batch is full and the caller must flush first. */
static bool consume_one(const csi_ring_slot_t *slot)
{
    const csi_ring_meta_t *m = &slot->meta;
    hcs_csi_record_t rec = {
        .rssi = m->rssi,
        .rate = m->rate,
        .sig_mode = m->sig_mode,
        .mcs = m->mcs,
        .bandwidth = m->bandwidth,
        .channel = m->channel,
        .secondary_channel = m->secondary_channel,
        .noise_floor = m->noise_floor,
        .rx_timestamp_us = m->rx_timestamp_us,
        .csi_format = m->csi_format,
        .csi_len = m->csi_len,
        .csi_data = slot->data,
    };
    memcpy(rec.src_mac, m->src_mac, 6);
    memcpy(rec.dst_mac, m->dst_mac, 6);

    switch (csi_batcher_append(&s_batcher, &rec)) {
    case CSI_BATCH_APPENDED:
        return true;
    case CSI_BATCH_FULL:
        return false; /* caller flushes and retries this same slot */
    case CSI_BATCH_RECORD_TOO_LARGE:
    default:
        /* proto S11: undeliverable by construction. Drop and count. */
        s_stats.records_too_large++;
        return true; /* "consumed": release it so the ring keeps moving */
    }
}

/* --- task --------------------------------------------------------------- */

static void uplink_task(void *arg)
{
    (void)arg;
    csi_ring_t *ring = csi_capture_ring();

    /* Subscribe to the task watchdog: if this loop stops turning, the node
     * has stopped doing its job and a reboot is the right answer. */
    const esp_err_t wdt = esp_task_wdt_add(NULL);
    if (wdt != ESP_OK) {
        ESP_LOGW(TAG, "esp_task_wdt_add: %s", esp_err_to_name(wdt));
    }

    int64_t next_heartbeat_us =
        esp_timer_get_time() + (int64_t)s_cfg.heartbeat_interval_ms * 1000;
    bool debug_socket_tried = false;

    for (;;) {
        esp_task_wdt_reset();

        if (wifi_link_is_connected() && !debug_socket_tried) {
            open_debug_socket();
            debug_socket_tried = true;
        }

        /* 1. Drain the ring into the current batch. Bounded per iteration so
         *    heartbeats and the watchdog never starve under a flood. */
        for (int i = 0; i < 64; i++) {
            const csi_ring_slot_t *slot = csi_ring_peek(ring);
            if (slot == NULL) {
                break;
            }
            debug_emit(slot);
            if (!consume_one(slot)) {
                flush_batch(); /* trigger 1/2 of proto S11 */
                continue;      /* retry the same slot on the fresh batch */
            }
            csi_ring_release(ring);
        }

        /* 2. Time-budget flush (trigger 3 of proto S11). */
        if (csi_batcher_flush_due(&s_batcher, time_sync_mono_us())) {
            flush_batch();
        }

        /* 3. Heartbeat on a fixed interval, independent of CSI activity, so
         *    a silently dead node is distinguishable from a still house. */
        const int64_t now = esp_timer_get_time();
        if (now >= next_heartbeat_us) {
            next_heartbeat_us = now + (int64_t)s_cfg.heartbeat_interval_ms * 1000;

            hcs_heartbeat_t hb;
            heartbeat_build(&hb, s_stats.batches_sent, s_stats.send_failures,
                            s_stats.records_too_large);
            uint8_t payload[HCS_HEARTBEAT_LEN];
            if (hcs_heartbeat_encode(payload, sizeof payload, &hb)
                == HCS_HEARTBEAT_LEN) {
                if (seal_and_send(HCS_MSG_HEARTBEAT, payload, sizeof payload)) {
                    s_stats.heartbeats_sent++;
                }
            }
            heartbeat_log(&hb);
        }

        /* 4. LED: streaming vs "on Wi-Fi but the server is not reachable". */
        if (!wifi_link_is_connected()) {
            status_led_set(LED_STATE_CONNECTING);
        } else if (s_stats.send_failures > 0
                   && esp_timer_get_time() < s_next_send_attempt_us) {
            status_led_set(LED_STATE_NO_SERVER);
        } else if (s_has_sent) {
            status_led_set(LED_STATE_STREAMING);
        } else {
            status_led_set(LED_STATE_NO_SERVER);
        }

        vTaskDelay(pdMS_TO_TICKS(UPLINK_POLL_MS));
    }
}

esp_err_t net_uplink_start(const node_config_t *cfg, uint32_t boot_epoch)
{
    if (cfg == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    s_cfg = *cfg;
    memset(&s_stats, 0, sizeof s_stats);

    if (hcs_seq_init(&s_seq, s_cfg.node_id, boot_epoch) != HCS_OK) {
        ESP_LOGE(TAG, "invalid node_id %u - refusing to start the uplink",
                 (unsigned)s_cfg.node_id);
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_cfg.psk_present) {
        ESP_LOGE(TAG, "no PSK - refusing to start the uplink");
        return ESP_ERR_INVALID_STATE;
    }
    const esp_err_t cerr = hcs_crypto_init(&s_crypto, s_cfg.psk);
    if (cerr != ESP_OK) {
        return cerr;
    }

    csi_batcher_init(&s_batcher, s_cfg.max_records_per_batch,
                     s_cfg.flush_budget_ms);

    ESP_LOGI(TAG,
             "uplink: node_id=%u boot_epoch=%u -> %s:%u, batches <=%u records "
             "/ <=%u ms",
             (unsigned)s_cfg.node_id, (unsigned)boot_epoch, s_cfg.server_host,
             (unsigned)s_cfg.server_port,
             (unsigned)s_batcher.max_records,
             (unsigned)s_batcher.flush_budget_ms);

    if (xTaskCreate(uplink_task, "uplink", UPLINK_TASK_STACK, NULL,
                    UPLINK_TASK_PRIO, NULL)
        != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void net_uplink_get_stats(net_uplink_stats_t *out)
{
    if (out) {
        *out = s_stats;
    }
}

bool net_uplink_has_sent(void)
{
    return s_has_sent;
}
