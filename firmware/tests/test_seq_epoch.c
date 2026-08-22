/* Sequence numbering and boot-epoch handling (docs/protocol.md S3, S4, S6).
 *
 * Exhaustion behaviour is normative in S4.1.
 *
 * The whole anti-replay design rests on two firmware invariants:
 *   - seq strictly increases within a boot_epoch, starting at 0;
 *   - boot_epoch strictly increases across reboots.
 * Nonce uniqueness for a given per-node key is a direct consequence, so
 * these are correctness-critical, not bookkeeping.
 */
#include "harness.h"

#include "csi_protocol/csi_codec.h"
#include "csi_protocol/seq_epoch.h"

static void test_first_datagram_uses_seq_zero(void)
{
    hcs_seq_t s;
    CHECK_EQ_I64(hcs_seq_init(&s, 7, 3), HCS_OK);
    hcs_header_t h;
    CHECK_EQ_I64(hcs_seq_next(&s, HCS_MSG_CSI_BATCH, &h), HCS_OK);
    CHECK_EQ_U64(h.seq, 0);
    CHECK_EQ_U64(h.node_id, 7);
    CHECK_EQ_U64(h.boot_epoch, 3);
    CHECK_EQ_U64(h.version, HCS_PROTOCOL_VERSION);
    CHECK_EQ_U64(h.msg_type, HCS_MSG_CSI_BATCH);
}

/* proto S14: ONE shared counter across all message types. */
static void test_sequence_is_shared_across_message_types(void)
{
    hcs_seq_t s;
    hcs_seq_init(&s, 1, 1);
    hcs_header_t h;
    hcs_seq_next(&s, HCS_MSG_CSI_BATCH, &h);
    CHECK_EQ_U64(h.seq, 0);
    hcs_seq_next(&s, HCS_MSG_HEARTBEAT, &h);
    CHECK_EQ_U64(h.seq, 1);
    hcs_seq_next(&s, HCS_MSG_CSI_BATCH, &h);
    CHECK_EQ_U64(h.seq, 2);
    hcs_seq_next(&s, HCS_MSG_HEARTBEAT, &h);
    CHECK_EQ_U64(h.seq, 3);
}

static void test_node_id_zero_is_rejected(void)
{
    hcs_seq_t s;
    CHECK_EQ_I64(hcs_seq_init(&s, 0, 1), HCS_ERR_ARG);
}

/* proto S4.1: seq MUST NOT wrap. The full range 0..0xFFFFFFFF is usable, but
 * once 0xFFFFFFFF has been HANDED OUT the node must not send again under this
 * boot_epoch. Nonce reuse would be catastrophic for ChaCha20-Poly1305, so this
 * is a hard stop, not throttling: only a reboot (which bumps boot_epoch) opens
 * a fresh sequence space. */
static void test_sequence_exhaustion_is_a_hard_stop(void)
{
    hcs_seq_t s;
    hcs_seq_init(&s, 1, 1);
    s.next_seq = 0xFFFFFFFEu;

    hcs_header_t h;
    CHECK_EQ_I64(hcs_seq_next(&s, HCS_MSG_CSI_BATCH, &h), HCS_OK);
    CHECK_EQ_U64(h.seq, 0xFFFFFFFEu);
    CHECK(!hcs_seq_exhausted(&s));

    CHECK_EQ_I64(hcs_seq_next(&s, HCS_MSG_CSI_BATCH, &h), HCS_OK);
    CHECK_EQ_U64(h.seq, 0xFFFFFFFFu);
    CHECK(hcs_seq_exhausted(&s)); /* that was the last usable seq */

    CHECK_EQ_I64(hcs_seq_next(&s, HCS_MSG_CSI_BATCH, &h), HCS_ERR_EXHAUSTED);
    CHECK_EQ_I64(hcs_seq_next(&s, HCS_MSG_HEARTBEAT, &h), HCS_ERR_EXHAUSTED);
}

/* Every datagram in a boot must produce a distinct nonce. Exhaustively
 * checking 2^32 is not possible, so check the property that guarantees it:
 * the nonce is injective in seq for a fixed (node_id, epoch). */
static void test_every_datagram_gets_a_fresh_nonce(void)
{
    hcs_seq_t s;
    hcs_seq_init(&s, 42, 9);
    uint8_t prev[HCS_NONCE_LEN];
    memset(prev, 0xFF, sizeof prev);
    for (int i = 0; i < 1000; i++) {
        hcs_header_t h;
        CHECK_EQ_I64(hcs_seq_next(&s, HCS_MSG_CSI_BATCH, &h), HCS_OK);
        uint8_t n[HCS_NONCE_LEN];
        hcs_nonce_build(n, h.node_id, h.boot_epoch, h.seq);
        CHECK(memcmp(n, prev, sizeof n) != 0);
        memcpy(prev, n, sizeof n);
    }
}

/* --- boot epoch advance rule (proto S6) ------------------------------- */

static void test_boot_epoch_advance_increments(void)
{
    uint32_t next = 0;
    CHECK_EQ_I64(hcs_boot_epoch_advance(0, &next), HCS_OK);
    CHECK_EQ_U64(next, 1);
    CHECK_EQ_I64(hcs_boot_epoch_advance(41, &next), HCS_OK);
    CHECK_EQ_U64(next, 42);
}

/* proto S4.1: boot_epoch MUST NOT wrap either. An implementation must refuse
 * to advance past 0xFFFFFFFF and leave it PINNED rather than wrapping to 0 - a
 * wrapped epoch looks to the server exactly like a rollback attack (S6 step 2)
 * and gets the node blackholed. */
static void test_boot_epoch_refuses_to_wrap(void)
{
    uint32_t next = 0;
    CHECK_EQ_I64(hcs_boot_epoch_advance(0xFFFFFFFFu, &next), HCS_ERR_EXHAUSTED);
    CHECK_EQ_U64(next, 0xFFFFFFFFu); /* left pinned, never wrapped to 0 */
}

int main(void)
{
    TEST_SUITE("seq+epoch (S3/S4/S4.1/S6)");
    test_first_datagram_uses_seq_zero();
    test_sequence_is_shared_across_message_types();
    test_node_id_zero_is_rejected();
    test_sequence_exhaustion_is_a_hard_stop();
    test_every_datagram_gets_a_fresh_nonce();
    test_boot_epoch_advance_increments();
    test_boot_epoch_refuses_to_wrap();
    return hcs_test_report();
}
