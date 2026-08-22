/* Byte-layout tests for docs/protocol.md sections 3, 4, 9 and 10.
 *
 * These exercise the *same* source file the firmware compiles
 * (components/csi_protocol/csi_codec.c) - the layout is never duplicated.
 */
#include "harness.h"

#include "csi_protocol/csi_codec.h"
#include "csi_protocol/csi_wire.h"

/* --- section 3: cleartext header ------------------------------------- */

static void test_header_layout(void)
{
    hcs_header_t h = {
        .version = HCS_PROTOCOL_VERSION,
        .msg_type = HCS_MSG_CSI_BATCH,
        .node_id = 0x0107,
        .boot_epoch = 0x00030201,
        .seq = 0x0A0B0C0D,
    };
    uint8_t buf[HCS_HEADER_LEN];
    CHECK_EQ_U64(hcs_header_encode(buf, sizeof buf, &h), HCS_HEADER_LEN);

    static const uint8_t want[HCS_HEADER_LEN] = {
        /* 0  magic      */ 0x48, 0x43, 0x53, 0x31,
        /* 4  version    */ 0x01,
        /* 5  msg_type   */ 0x01,
        /* 6  node_id    */ 0x07, 0x01,
        /* 8  boot_epoch */ 0x01, 0x02, 0x03, 0x00,
        /* 12 seq        */ 0x0D, 0x0C, 0x0B, 0x0A,
        /* 16 nonce      */ 0x07, 0x01,
                            0x01, 0x02, 0x03, 0x00,
                            0x0D, 0x0C, 0x0B, 0x0A,
                            0x00, 0x00,
    };
    CHECK_BYTES(buf, want, sizeof want);
}

static void test_header_rejects_short_buffer(void)
{
    hcs_header_t h = { .version = 1, .msg_type = 1, .node_id = 1 };
    uint8_t buf[HCS_HEADER_LEN - 1];
    CHECK_EQ_U64(hcs_header_encode(buf, sizeof buf, &h), 0);
}

/* --- section 4: nonce construction ----------------------------------- */

static void test_nonce_is_identity_packing(void)
{
    uint8_t n[HCS_NONCE_LEN];
    hcs_nonce_build(n, 7, 3, 42);
    static const uint8_t want[HCS_NONCE_LEN] = {
        0x07, 0x00,
        0x03, 0x00, 0x00, 0x00,
        0x2a, 0x00, 0x00, 0x00,
        0x00, 0x00,
    };
    CHECK_BYTES(n, want, sizeof want);
}

static void test_nonce_reserved_bytes_always_zero(void)
{
    uint8_t n[HCS_NONCE_LEN];
    hcs_nonce_build(n, 0xFFFF, 0xFFFFFFFFu, 0xFFFFFFFFu);
    CHECK_EQ_U64(n[10], 0);
    CHECK_EQ_U64(n[11], 0);
    for (int i = 0; i < 10; i++) {
        CHECK_EQ_U64(n[i], 0xFF);
    }
}

/* Structural uniqueness: distinct (node_id, epoch, seq) gives distinct nonce. */
static void test_nonce_unique_per_identity(void)
{
    uint8_t a[HCS_NONCE_LEN], b[HCS_NONCE_LEN];
    hcs_nonce_build(a, 7, 3, 42);
    hcs_nonce_build(b, 7, 3, 43);
    CHECK(memcmp(a, b, sizeof a) != 0);
    hcs_nonce_build(b, 7, 4, 42);
    CHECK(memcmp(a, b, sizeof a) != 0);
    hcs_nonce_build(b, 8, 3, 42);
    CHECK(memcmp(a, b, sizeof a) != 0);
}

/* --- section 3/4: decoder-side verification -------------------------- */

static void test_header_decode_roundtrip(void)
{
    hcs_header_t in = { .version = 1, .msg_type = HCS_MSG_HEARTBEAT,
                        .node_id = 9, .boot_epoch = 11, .seq = 12345 };
    uint8_t buf[HCS_HEADER_LEN];
    hcs_header_encode(buf, sizeof buf, &in);

    hcs_header_t out;
    CHECK_EQ_I64(hcs_header_decode(&out, buf, sizeof buf), HCS_OK);
    CHECK_EQ_U64(out.node_id, 9);
    CHECK_EQ_U64(out.boot_epoch, 11);
    CHECK_EQ_U64(out.seq, 12345);
    CHECK_EQ_U64(out.msg_type, HCS_MSG_HEARTBEAT);
    CHECK_EQ_U64(out.version, 1);
}

static void test_header_decode_rejects_bad_magic(void)
{
    hcs_header_t in = { .version = 1, .msg_type = 1, .node_id = 1 };
    uint8_t buf[HCS_HEADER_LEN];
    hcs_header_encode(buf, sizeof buf, &in);
    buf[0] = 'X';
    hcs_header_t out;
    CHECK_EQ_I64(hcs_header_decode(&out, buf, sizeof buf), HCS_ERR_MAGIC);
}

static void test_header_decode_rejects_tampered_nonce(void)
{
    hcs_header_t in = { .version = 1, .msg_type = 1, .node_id = 1,
                        .boot_epoch = 2, .seq = 3 };
    uint8_t buf[HCS_HEADER_LEN];
    hcs_header_encode(buf, sizeof buf, &in);
    buf[16 + 6] ^= 0x01; /* flip a seq byte inside the nonce only */
    hcs_header_t out;
    CHECK_EQ_I64(hcs_header_decode(&out, buf, sizeof buf), HCS_ERR_NONCE);

    hcs_header_encode(buf, sizeof buf, &in);
    buf[16 + 11] = 0x01; /* reserved nonce byte must be zero */
    CHECK_EQ_I64(hcs_header_decode(&out, buf, sizeof buf), HCS_ERR_NONCE);
}

/* --- section 9.1: batch header --------------------------------------- */

static void test_batch_header_layout(void)
{
    hcs_batch_header_t bh = {
        .wall_clock_us = 0x0102030405060708ull,
        .mono_us = 0x1112131415161718ull,
        .sntp_synced = 1,
        .record_count = 0x0201,
    };
    uint8_t buf[HCS_BATCH_HEADER_LEN];
    CHECK_EQ_U64(hcs_batch_header_encode(buf, sizeof buf, &bh),
                 HCS_BATCH_HEADER_LEN);
    static const uint8_t want[HCS_BATCH_HEADER_LEN] = {
        0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
        0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11,
        0x01,
        0x00, 0x00, 0x00,
        0x01, 0x02,
    };
    CHECK_BYTES(buf, want, sizeof want);
}

/* --- section 9.2: CSI record ----------------------------------------- */

static void test_record_layout(void)
{
    const uint8_t csi[4] = { 0x01, 0x02, 0x03, 0x04 };
    hcs_csi_record_t r = {
        .src_mac = { 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01 },
        .dst_mac = { 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff },
        .rssi = -42,
        .rate = 11,
        .sig_mode = 1,
        .mcs = 7,
        .bandwidth = 0,
        .channel = 6,
        .secondary_channel = 0,
        .noise_floor = -95,
        .rx_timestamp_us = 123456700,
        .csi_format = HCS_CSI_FORMAT_LLTF,
        .csi_len = 4,
        .csi_data = csi,
    };
    uint8_t buf[HCS_RECORD_FIXED_LEN + 4];
    CHECK_EQ_U64(hcs_record_encode(buf, sizeof buf, &r), sizeof buf);

    static const uint8_t want[HCS_RECORD_FIXED_LEN + 4] = {
        /* 0  src_mac */ 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x01,
        /* 6  dst_mac */ 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
        /* 12 rssi    */ 0xd6,
        /* 13 rate    */ 0x0b,
        /* 14 sig     */ 0x01,
        /* 15 mcs     */ 0x07,
        /* 16 bw      */ 0x00,
        /* 17 chan    */ 0x06,
        /* 18 sec     */ 0x00,
        /* 19 noise   */ 0xa1,
        /* 20 rx_ts   */ 0xbc, 0xcc, 0x5b, 0x07, 0x00, 0x00, 0x00, 0x00,
                         /* 123456700 == 0x075BCCBC */
        /* 28 fmt     */ 0x00,
        /* 29 csi_len */ 0x04, 0x00,
        /* 31 data    */ 0x01, 0x02, 0x03, 0x04,
    };
    CHECK_BYTES(buf, want, sizeof want);
}

static void test_record_encode_respects_capacity(void)
{
    const uint8_t csi[4] = { 1, 2, 3, 4 };
    hcs_csi_record_t r = { .csi_len = 4, .csi_data = csi };
    uint8_t buf[HCS_RECORD_FIXED_LEN + 3];
    CHECK_EQ_U64(hcs_record_encode(buf, sizeof buf, &r), 0);
}

/* --- section 10: heartbeat ------------------------------------------- */

static void test_heartbeat_layout(void)
{
    hcs_heartbeat_t hb = {
        .uptime_s = 0x04030201,
        .free_heap_bytes = 0x14131211,
        .min_free_heap_bytes = 0x24232221,
        .frames_captured = 0x34333231,
        .frames_dropped = 0x44434241,
        .batches_sent = 0x54535251,
        .send_failures = 0x64636261,
        .rssi_to_ap = -55,
        .channel = 6,
        .sntp_synced = 1,
        .fw_version_major = 1,
        .fw_version_minor = 2,
        .fw_version_patch = 3,
    };
    uint8_t buf[HCS_HEARTBEAT_LEN];
    CHECK_EQ_U64(hcs_heartbeat_encode(buf, sizeof buf, &hb), HCS_HEARTBEAT_LEN);
    static const uint8_t want[HCS_HEARTBEAT_LEN] = {
        0x01, 0x02, 0x03, 0x04,
        0x11, 0x12, 0x13, 0x14,
        0x21, 0x22, 0x23, 0x24,
        0x31, 0x32, 0x33, 0x34,
        0x41, 0x42, 0x43, 0x44,
        0x51, 0x52, 0x53, 0x54,
        0x61, 0x62, 0x63, 0x64,
        0xc9,       /* rssi -55 */
        0x06,
        0x01,
        0x01, 0x02, 0x03,
        0x00, 0x00,
    };
    CHECK_BYTES(buf, want, sizeof want);
}

/* --- section 11: declared limits are self-consistent ------------------ */

static void test_size_constants_agree_with_spec(void)
{
    CHECK_EQ_U64(HCS_HEADER_LEN, 28);
    CHECK_EQ_U64(HCS_TAG_LEN, 16);
    CHECK_EQ_U64(HCS_NONCE_LEN, 12);
    CHECK_EQ_U64(HCS_KEY_LEN, 32);
    CHECK_EQ_U64(HCS_MAX_DATAGRAM_LEN, 1200);
    CHECK_EQ_U64(HCS_MAX_PLAINTEXT_LEN, 1156);
    CHECK_EQ_U64(HCS_MAX_PLAINTEXT_LEN,
                 HCS_MAX_DATAGRAM_LEN - HCS_HEADER_LEN - HCS_TAG_LEN);
    CHECK_EQ_U64(HCS_BATCH_HEADER_LEN, 22);
    CHECK_EQ_U64(HCS_RECORD_FIXED_LEN, 31);
    CHECK_EQ_U64(HCS_HEARTBEAT_LEN, 36);
    CHECK_EQ_U64(HCS_MAX_CSI_LEN_IN_BATCH, 1103);
    CHECK_EQ_U64(HCS_MAX_CSI_LEN_IN_BATCH,
                 HCS_MAX_PLAINTEXT_LEN - HCS_BATCH_HEADER_LEN
                     - HCS_RECORD_FIXED_LEN);
}

int main(void)
{
    TEST_SUITE("wire layout (proto S3/4/9/10)");
    test_header_layout();
    test_header_rejects_short_buffer();
    test_nonce_is_identity_packing();
    test_nonce_reserved_bytes_always_zero();
    test_nonce_unique_per_identity();
    test_header_decode_roundtrip();
    test_header_decode_rejects_bad_magic();
    test_header_decode_rejects_tampered_nonce();
    test_batch_header_layout();
    test_record_layout();
    test_record_encode_respects_capacity();
    test_heartbeat_layout();
    test_size_constants_agree_with_spec();
    return hcs_test_report();
}
