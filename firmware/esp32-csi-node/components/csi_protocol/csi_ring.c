/*
 * csi_ring.c - see csi_ring.h for the design rationale.
 *
 * Hard constraints honoured here:
 *   - no allocation anywhere (storage is caller-supplied);
 *   - push() is bounded-time: one memcpy of at most CSI_RING_MAX_CSI_LEN;
 *   - push() never blocks, so it is safe from the Wi-Fi task;
 *   - a full ring drops the *incoming* record and counts it. Frames are
 *     never silently lost: every drop lands in a counter that the heartbeat
 *     reports (proto S10 frames_dropped).
 */

#include "csi_protocol/csi_ring.h"

#include <string.h>

void csi_ring_init(csi_ring_t *r, csi_ring_slot_t *storage, uint32_t capacity)
{
    if (r == NULL) {
        return;
    }
    memset(r, 0, sizeof(*r));
    r->slots = storage;
    r->capacity = (capacity == 0u) ? 1u : capacity;
    atomic_store_explicit(&r->head, 0u, memory_order_relaxed);
    atomic_store_explicit(&r->tail, 0u, memory_order_relaxed);
}

uint32_t csi_ring_capacity(const csi_ring_t *r)
{
    return (r != NULL) ? r->capacity : 0u;
}

uint32_t csi_ring_used(const csi_ring_t *r)
{
    if (r == NULL) {
        return 0u;
    }
    const uint32_t head = atomic_load_explicit(&r->head, memory_order_acquire);
    const uint32_t tail = atomic_load_explicit(&r->tail, memory_order_acquire);
    /* Unsigned subtraction is well defined across wraparound. */
    return head - tail;
}

bool csi_ring_is_empty(const csi_ring_t *r)
{
    return csi_ring_used(r) == 0u;
}

bool csi_ring_is_full(const csi_ring_t *r)
{
    return r != NULL && csi_ring_used(r) >= r->capacity;
}

uint32_t csi_ring_used_pct(const csi_ring_t *r)
{
    if (r == NULL || r->capacity == 0u) {
        return 0u;
    }
    uint64_t used = csi_ring_used(r);
    if (used > r->capacity) {
        used = r->capacity;
    }
    return (uint32_t)((used * 100u) / r->capacity);
}

bool csi_ring_push(csi_ring_t *r, const csi_ring_meta_t *meta,
                   const uint8_t *csi, uint16_t csi_len)
{
    if (r == NULL || r->slots == NULL || meta == NULL) {
        return false;
    }
    if (csi_len > CSI_RING_MAX_CSI_LEN || (csi_len != 0u && csi == NULL)) {
        r->drops_oversize++;
        return false;
    }

    const uint32_t head = atomic_load_explicit(&r->head, memory_order_relaxed);
    const uint32_t tail = atomic_load_explicit(&r->tail, memory_order_acquire);
    if ((head - tail) >= r->capacity) {
        r->drops_full++;
        return false;
    }

    csi_ring_slot_t *slot = &r->slots[head % r->capacity];
    slot->meta = *meta;
    slot->meta.csi_len = csi_len;
    if (csi_len != 0u) {
        memcpy(slot->data, csi, csi_len);
    }

    /* Release: everything written to the slot above must be visible to the
     * consumer before it can observe the new head. */
    atomic_store_explicit(&r->head, head + 1u, memory_order_release);

    r->pushed++;
    const uint32_t used = (head + 1u) - tail;
    if (used > r->high_water) {
        r->high_water = used;
    }
    return true;
}

const csi_ring_slot_t *csi_ring_peek(const csi_ring_t *r)
{
    if (r == NULL || r->slots == NULL) {
        return NULL;
    }
    const uint32_t head = atomic_load_explicit(&r->head, memory_order_acquire);
    const uint32_t tail = atomic_load_explicit(&r->tail, memory_order_relaxed);
    if (head == tail) {
        return NULL;
    }
    return &r->slots[tail % r->capacity];
}

void csi_ring_release(csi_ring_t *r)
{
    if (r == NULL) {
        return;
    }
    const uint32_t head = atomic_load_explicit(&r->head, memory_order_acquire);
    const uint32_t tail = atomic_load_explicit(&r->tail, memory_order_relaxed);
    if (head == tail) {
        return; /* nothing to release */
    }
    atomic_store_explicit(&r->tail, tail + 1u, memory_order_release);
    r->popped++;
}
