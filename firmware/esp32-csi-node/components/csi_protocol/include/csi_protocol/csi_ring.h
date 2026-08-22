/*
 * csi_ring.h - lock-free single-producer/single-consumer ring buffer for CSI
 * records.
 *
 * WHY THIS SHAPE:
 *   The ESP32 CSI callback runs in the Wi-Fi task. Anything slow there - a
 *   mutex, a malloc, a socket write - stalls the Wi-Fi driver and turns CSI
 *   arrival into bursty garbage. So the callback does exactly one thing:
 *   memcpy into a pre-allocated slot here and return. Every other stage
 *   (budgeting, batching, crypto, UDP) happens on the uplink task, which is
 *   the single consumer.
 *
 *   Storage is caller-supplied (a static array in csi_capture.c), so nothing
 *   in this file allocates, ever.
 *
 * CONCURRENCY MODEL:
 *   Exactly one producer task and exactly one consumer task. head and tail
 *   are free-running C11 atomics; used = head - tail works correctly across
 *   uint32 wraparound, which is why all CAPACITY slots are usable instead of
 *   the usual "leave one empty" hack.
 *
 * Host-compilable: no ESP-IDF, no FreeRTOS.
 */
#ifndef CSI_PROTOCOL_CSI_RING_H
#define CSI_PROTOCOL_CSI_RING_H

#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>

#include "csi_protocol/csi_wire.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Largest raw CSI payload a single slot can hold.
 *
 * UNVERIFIED ON REAL HARDWARE: the ESP32 Wi-Fi driver reports CSI buffer
 * lengths that depend on the decoded frame format and bandwidth; commonly
 * cited values are 128 (LLTF only), 256/384 (LLTF+HT-LTF) and 612 (HT40).
 * This deployment pins 20 MHz, so 384 should be the ceiling - but "should"
 * is not "measured". Anything longer than this is dropped and counted in
 * drops_oversize rather than truncated, and csi-hello prints the real
 * lengths so the value can be set from evidence.
 *
 * Override at build time with -DCSI_RING_MAX_CSI_LEN=<n> (Kconfig does this
 * for the firmware build). */
#ifndef CSI_RING_MAX_CSI_LEN
#define CSI_RING_MAX_CSI_LEN 384
#endif

#if CSI_RING_MAX_CSI_LEN > HCS_MAX_CSI_LEN_IN_BATCH
#error "CSI_RING_MAX_CSI_LEN exceeds what a single batch can carry (proto S11)"
#endif

/* Where a captured frame came from. Drives separate rate budgets: peer
 * soundings are the primary signal, foreign traffic is best-effort garnish
 * (see docs/architecture.md). */
typedef enum {
    CSI_SOURCE_PEER_SOUNDING = 0, /* another node's broadcast sounding */
    CSI_SOURCE_AP = 1,            /* the dedicated AP we are associated to */
    CSI_SOURCE_FOREIGN = 2        /* anything else on the channel */
} csi_source_class_t;

/* Fixed metadata copied out of wifi_pkt_rx_ctrl_t in the callback. Mirrors
 * the wire record (proto S9.2) minus the raw bytes, plus routing info the
 * uplink needs. */
typedef struct {
    uint8_t src_mac[6];
    uint8_t dst_mac[6];
    int8_t rssi;
    uint8_t rate;
    uint8_t sig_mode;
    uint8_t mcs;
    uint8_t bandwidth;
    uint8_t channel;
    uint8_t secondary_channel;
    int8_t noise_floor;
    uint64_t rx_timestamp_us;
    uint8_t csi_format;    /* hcs_csi_format_t, tagged per record (proto S9.3) */
    uint16_t csi_len;      /* actual bytes valid in slot->data */
    uint8_t source_class;  /* csi_source_class_t */
} csi_ring_meta_t;

typedef struct {
    csi_ring_meta_t meta;
    uint8_t data[CSI_RING_MAX_CSI_LEN];
} csi_ring_slot_t;

typedef struct {
    csi_ring_slot_t *slots;
    uint32_t capacity;

    _Atomic uint32_t head; /* producer-owned, free running */
    _Atomic uint32_t tail; /* consumer-owned, free running */

    /* Producer-owned counters (only the CSI callback touches these). */
    uint32_t pushed;
    uint32_t drops_full;
    uint32_t drops_oversize;
    uint32_t high_water;

    /* Consumer-owned counter. */
    uint32_t popped;
} csi_ring_t;

/* capacity must be >= 1. storage must hold `capacity` slots and outlive the
 * ring. Nothing is allocated. */
void csi_ring_init(csi_ring_t *r, csi_ring_slot_t *storage, uint32_t capacity);

/* PRODUCER SIDE - safe to call from the Wi-Fi task / CSI callback.
 * Never blocks, never allocates. Returns false and bumps a drop counter when
 * the ring is full (drops_full) or the payload is too long (drops_oversize).
 * The new record is what gets dropped; queued data is never overwritten. */
bool csi_ring_push(csi_ring_t *r, const csi_ring_meta_t *meta,
                   const uint8_t *csi, uint16_t csi_len);

/* CONSUMER SIDE. peek returns a borrowed pointer to the oldest slot (NULL if
 * empty); it stays valid until the matching csi_ring_release(). This avoids
 * a second full copy of the CSI payload on the uplink path. */
const csi_ring_slot_t *csi_ring_peek(const csi_ring_t *r);
void csi_ring_release(csi_ring_t *r);

uint32_t csi_ring_used(const csi_ring_t *r);
uint32_t csi_ring_capacity(const csi_ring_t *r);
bool csi_ring_is_empty(const csi_ring_t *r);
bool csi_ring_is_full(const csi_ring_t *r);

/* Occupancy in percent (0-100), used by bandwidth_budget to decide when to
 * start decimating. */
uint32_t csi_ring_used_pct(const csi_ring_t *r);

#ifdef __cplusplus
}
#endif

#endif /* CSI_PROTOCOL_CSI_RING_H */
