/* Ring-buffer behaviour: wrap, full, drop counting, oversize rejection.
 *
 * The ring is the hand-off between the Wi-Fi task (CSI callback, producer)
 * and the uplink task (consumer). The callback must never allocate and never
 * block, so "full" has to mean "drop and count", not "wait".
 */
#include "harness.h"

#include "csi_protocol/csi_ring.h"

#define CAP 4

static csi_ring_slot_t g_slots[CAP];

static csi_ring_meta_t make_meta(uint8_t tag)
{
    csi_ring_meta_t m;
    memset(&m, 0, sizeof m);
    m.src_mac[5] = tag;
    m.rx_timestamp_us = tag;
    m.csi_format = HCS_CSI_FORMAT_LLTF;
    m.source_class = CSI_SOURCE_PEER_SOUNDING;
    return m;
}

static void reset(csi_ring_t *r)
{
    memset(g_slots, 0, sizeof g_slots);
    csi_ring_init(r, g_slots, CAP);
}

static void test_starts_empty(void)
{
    csi_ring_t r;
    reset(&r);
    CHECK(csi_ring_is_empty(&r));
    CHECK_EQ_U64(csi_ring_used(&r), 0);
    CHECK_EQ_U64(csi_ring_capacity(&r), CAP);
    CHECK(csi_ring_peek(&r) == NULL);
}

static void test_push_then_peek_returns_same_payload(void)
{
    csi_ring_t r;
    reset(&r);
    const uint8_t csi[3] = { 0x11, 0x22, 0x33 };
    csi_ring_meta_t m = make_meta(7);
    CHECK(csi_ring_push(&r, &m, csi, 3));
    CHECK_EQ_U64(csi_ring_used(&r), 1);

    const csi_ring_slot_t *s = csi_ring_peek(&r);
    CHECK(s != NULL);
    if (s) {
        CHECK_EQ_U64(s->meta.csi_len, 3);
        CHECK_EQ_U64(s->meta.src_mac[5], 7);
        CHECK_BYTES(s->data, csi, 3);
    }
    csi_ring_release(&r);
    CHECK(csi_ring_is_empty(&r));
}

/* All CAP slots are usable: the implementation uses free-running indices
 * rather than the classic "keep one slot empty" trick. */
static void test_fills_entire_capacity(void)
{
    csi_ring_t r;
    reset(&r);
    const uint8_t csi[1] = { 0 };
    for (int i = 0; i < CAP; i++) {
        csi_ring_meta_t m = make_meta((uint8_t)i);
        CHECK(csi_ring_push(&r, &m, csi, 1));
    }
    CHECK_EQ_U64(csi_ring_used(&r), CAP);
    CHECK(csi_ring_is_full(&r));
}

static void test_push_when_full_drops_and_counts(void)
{
    csi_ring_t r;
    reset(&r);
    const uint8_t csi[1] = { 0 };
    for (int i = 0; i < CAP; i++) {
        csi_ring_meta_t m = make_meta((uint8_t)i);
        csi_ring_push(&r, &m, csi, 1);
    }
    csi_ring_meta_t m = make_meta(99);
    CHECK(!csi_ring_push(&r, &m, csi, 1));
    CHECK_EQ_U64(r.drops_full, 1);
    CHECK_EQ_U64(csi_ring_used(&r), CAP);

    /* The oldest record must still be intact - a full ring drops the NEW
     * record, it never corrupts or overwrites queued data. */
    const csi_ring_slot_t *s = csi_ring_peek(&r);
    CHECK(s != NULL);
    if (s) {
        CHECK_EQ_U64(s->meta.src_mac[5], 0);
    }
}

static void test_wraps_around_many_times(void)
{
    csi_ring_t r;
    reset(&r);
    const uint8_t csi[2] = { 0xAB, 0xCD };
    for (int i = 0; i < CAP * 7 + 3; i++) {
        csi_ring_meta_t m = make_meta((uint8_t)i);
        CHECK(csi_ring_push(&r, &m, csi, 2));
        const csi_ring_slot_t *s = csi_ring_peek(&r);
        CHECK(s != NULL);
        if (s) {
            CHECK_EQ_U64(s->meta.src_mac[5], (uint8_t)i);
            CHECK_BYTES(s->data, csi, 2);
        }
        csi_ring_release(&r);
    }
    CHECK(csi_ring_is_empty(&r));
    CHECK_EQ_U64(r.drops_full, 0);
    CHECK_EQ_U64(r.pushed, (uint32_t)(CAP * 7 + 3));
    CHECK_EQ_U64(r.popped, (uint32_t)(CAP * 7 + 3));
}

static void test_partial_drain_keeps_fifo_order(void)
{
    csi_ring_t r;
    reset(&r);
    const uint8_t csi[1] = { 0 };
    for (int i = 0; i < CAP; i++) {
        csi_ring_meta_t m = make_meta((uint8_t)(10 + i));
        csi_ring_push(&r, &m, csi, 1);
    }
    for (int i = 0; i < 2; i++) {
        const csi_ring_slot_t *s = csi_ring_peek(&r);
        CHECK(s != NULL);
        if (s) {
            CHECK_EQ_U64(s->meta.src_mac[5], (uint8_t)(10 + i));
        }
        csi_ring_release(&r);
    }
    /* room for two more */
    for (int i = 0; i < 2; i++) {
        csi_ring_meta_t m = make_meta((uint8_t)(20 + i));
        CHECK(csi_ring_push(&r, &m, csi, 1));
    }
    CHECK(csi_ring_is_full(&r));
    const uint8_t expect_order[4] = { 12, 13, 20, 21 };
    for (int i = 0; i < 4; i++) {
        const csi_ring_slot_t *s = csi_ring_peek(&r);
        CHECK(s != NULL);
        if (s) {
            CHECK_EQ_U64(s->meta.src_mac[5], expect_order[i]);
        }
        csi_ring_release(&r);
    }
}

static void test_oversize_payload_is_rejected_and_counted(void)
{
    csi_ring_t r;
    reset(&r);
    static uint8_t big[CSI_RING_MAX_CSI_LEN + 1];
    csi_ring_meta_t m = make_meta(1);
    CHECK(!csi_ring_push(&r, &m, big, CSI_RING_MAX_CSI_LEN + 1));
    CHECK_EQ_U64(r.drops_oversize, 1);
    CHECK_EQ_U64(r.drops_full, 0);
    CHECK(csi_ring_is_empty(&r));

    /* exactly at the limit is fine */
    CHECK(csi_ring_push(&r, &m, big, CSI_RING_MAX_CSI_LEN));
    CHECK_EQ_U64(r.drops_oversize, 1);
}

static void test_release_on_empty_is_a_noop(void)
{
    csi_ring_t r;
    reset(&r);
    csi_ring_release(&r);
    CHECK(csi_ring_is_empty(&r));
    CHECK_EQ_U64(r.popped, 0);
}

/* The high-water mark drives the bandwidth budget's decimation, so it has to
 * survive drains rather than tracking instantaneous occupancy. */
static void test_tracks_high_water_mark(void)
{
    csi_ring_t r;
    reset(&r);
    const uint8_t csi[1] = { 0 };
    for (int i = 0; i < 3; i++) {
        csi_ring_meta_t m = make_meta((uint8_t)i);
        csi_ring_push(&r, &m, csi, 1);
    }
    CHECK_EQ_U64(r.high_water, 3);
    csi_ring_release(&r);
    csi_ring_release(&r);
    CHECK_EQ_U64(r.high_water, 3);
    CHECK_EQ_U64(csi_ring_used(&r), 1);
}

int main(void)
{
    TEST_SUITE("csi ring buffer");
    test_starts_empty();
    test_push_then_peek_returns_same_payload();
    test_fills_entire_capacity();
    test_push_when_full_drops_and_counts();
    test_wraps_around_many_times();
    test_partial_drain_keeps_fifo_order();
    test_oversize_payload_is_rejected_and_counted();
    test_release_on_empty_is_a_noop();
    test_tracks_high_water_mark();
    return hcs_test_report();
}
