/* Validates the host-side reference AEAD against RFC 8439, and the codec's
 * AAD/nonce plumbing (docs/protocol.md S2, S5).
 *
 * The firmware itself uses mbedTLS, not this implementation - but the tests
 * can only assert on real sealed bytes if the reference is provably correct
 * first, so this suite comes before test_docs_example.
 */
#include "harness.h"

#include "csi_protocol/csi_codec.h"
#include "ref_chacha20poly1305.h"

/* RFC 8439 section 2.8.2, the AEAD_CHACHA20_POLY1305 worked example. */
static void test_rfc8439_aead_vector(void)
{
    static const char plaintext_s[] =
        "Ladies and Gentlemen of the class of '99: If I could offer you only "
        "one tip for the future, sunscreen would be it.";
    const uint8_t *pt = (const uint8_t *)plaintext_s;
    const size_t pt_len = sizeof(plaintext_s) - 1;
    CHECK_EQ_U64(pt_len, 114);

    static const uint8_t aad[12] = { 0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1,
                                     0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7 };
    static const uint8_t key[32] = {
        0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
        0x8b, 0x8c, 0x8d, 0x8e, 0x8f, 0x90, 0x91, 0x92, 0x93, 0x94, 0x95,
        0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f
    };
    static const uint8_t nonce[12] = { 0x07, 0x00, 0x00, 0x00, 0x40, 0x41,
                                       0x42, 0x43, 0x44, 0x45, 0x46, 0x47 };

    static const uint8_t want_ct[114] = {
        0xd3, 0x1a, 0x8d, 0x34, 0x64, 0x8e, 0x60, 0xdb, 0x7b, 0x86, 0xaf, 0xbc,
        0x53, 0xef, 0x7e, 0xc2, 0xa4, 0xad, 0xed, 0x51, 0x29, 0x6e, 0x08, 0xfe,
        0xa9, 0xe2, 0xb5, 0xa7, 0x36, 0xee, 0x62, 0xd6, 0x3d, 0xbe, 0xa4, 0x5e,
        0x8c, 0xa9, 0x67, 0x12, 0x82, 0xfa, 0xfb, 0x69, 0xda, 0x92, 0x72, 0x8b,
        0x1a, 0x71, 0xde, 0x0a, 0x9e, 0x06, 0x0b, 0x29, 0x05, 0xd6, 0xa5, 0xb6,
        0x7e, 0xcd, 0x3b, 0x36, 0x92, 0xdd, 0xbd, 0x7f, 0x2d, 0x77, 0x8b, 0x8c,
        0x98, 0x03, 0xae, 0xe3, 0x28, 0x09, 0x1b, 0x58, 0xfa, 0xb3, 0x24, 0xe4,
        0xfa, 0xd6, 0x75, 0x94, 0x55, 0x85, 0x80, 0x8b, 0x48, 0x31, 0xd7, 0xbc,
        0x3f, 0xf4, 0xde, 0xf0, 0x8e, 0x4b, 0x7a, 0x9d, 0xe5, 0x76, 0xd2, 0x65,
        0x86, 0xce, 0xc6, 0x4b, 0x61, 0x16
    };
    static const uint8_t want_tag[16] = { 0x1a, 0xe1, 0x0b, 0x59, 0x4f, 0x09,
                                          0xe2, 0x6a, 0x7e, 0x90, 0x2e, 0xcb,
                                          0xd0, 0x60, 0x06, 0x91 };

    uint8_t ct[114];
    uint8_t tag[16];
    CHECK_EQ_I64(ref_chacha20poly1305_seal(NULL, key, nonce, aad, sizeof aad,
                                           pt, pt_len, ct, tag),
                 0);
    CHECK_BYTES(ct, want_ct, sizeof want_ct);
    CHECK_BYTES(tag, want_tag, sizeof want_tag);

    uint8_t round[114];
    CHECK_EQ_I64(ref_chacha20poly1305_open(key, nonce, aad, sizeof aad, ct,
                                           sizeof ct, tag, round),
                 0);
    CHECK_BYTES(round, pt, pt_len);
}

static void test_tampering_is_detected(void)
{
    static const uint8_t key[32] = { 1 };
    static const uint8_t nonce[12] = { 2 };
    static const uint8_t aad[4] = { 9, 8, 7, 6 };
    const uint8_t pt[5] = { 'h', 'e', 'l', 'l', 'o' };
    uint8_t ct[5], tag[16], out[5];

    ref_chacha20poly1305_seal(NULL, key, nonce, aad, sizeof aad, pt, sizeof pt,
                              ct, tag);
    CHECK_EQ_I64(
        ref_chacha20poly1305_open(key, nonce, aad, sizeof aad, ct, sizeof ct,
                                  tag, out),
        0);

    ct[0] ^= 0x01;
    CHECK(ref_chacha20poly1305_open(key, nonce, aad, sizeof aad, ct, sizeof ct,
                                    tag, out)
          != 0);
    ct[0] ^= 0x01;

    uint8_t bad_aad[4];
    memcpy(bad_aad, aad, sizeof aad);
    bad_aad[1] ^= 0x80;
    CHECK(ref_chacha20poly1305_open(key, nonce, bad_aad, sizeof bad_aad, ct,
                                    sizeof ct, tag, out)
          != 0);
}

/* Empty plaintext must still produce a valid tag over the AAD - relevant
 * because a CSI_BATCH always has a 22-byte body but a future message type
 * might not. */
static void test_empty_plaintext_still_authenticates_aad(void)
{
    static const uint8_t key[32] = { 3 };
    static const uint8_t nonce[12] = { 4 };
    static const uint8_t aad[28] = { 0x48, 0x43, 0x53, 0x31 };
    uint8_t tag[16];
    CHECK_EQ_I64(ref_chacha20poly1305_seal(NULL, key, nonce, aad, sizeof aad,
                                           NULL, 0, NULL, tag),
                 0);
    CHECK_EQ_I64(ref_chacha20poly1305_open(key, nonce, aad, sizeof aad, NULL, 0,
                                           tag, NULL),
                 0);
}

/* --- codec integration: header is the AAD, header nonce is the AEAD nonce - */

static void test_datagram_seal_uses_header_as_aad(void)
{
    static const uint8_t key[32] = { 0xAB };
    hcs_header_t h = { .version = 1, .msg_type = HCS_MSG_HEARTBEAT,
                       .node_id = 5, .boot_epoch = 6, .seq = 7 };
    const uint8_t pt[8] = { 1, 2, 3, 4, 5, 6, 7, 8 };
    uint8_t dg[HCS_MAX_DATAGRAM_LEN];
    size_t dg_len = 0;

    CHECK_EQ_I64(hcs_datagram_seal(dg, sizeof dg, &dg_len, &h, pt, sizeof pt,
                                   key, ref_chacha20poly1305_seal, NULL),
                 HCS_OK);
    CHECK_EQ_U64(dg_len, HCS_HEADER_LEN + sizeof pt + HCS_TAG_LEN);

    /* Header must be on the wire in the clear and unchanged. */
    hcs_header_t decoded;
    CHECK_EQ_I64(hcs_header_decode(&decoded, dg, dg_len), HCS_OK);
    CHECK_EQ_U64(decoded.node_id, 5);
    CHECK_EQ_U64(decoded.seq, 7);

    /* Opening with the header as AAD and the header's own nonce must work. */
    uint8_t out[8];
    CHECK_EQ_I64(ref_chacha20poly1305_open(key, &dg[HCS_HDR_OFF_NONCE], dg,
                                           HCS_HEADER_LEN,
                                           &dg[HCS_HEADER_LEN], sizeof pt,
                                           &dg[HCS_HEADER_LEN + sizeof pt],
                                           out),
                 0);
    CHECK_BYTES(out, pt, sizeof pt);

    /* Flipping any header byte must break the tag: the header is
     * authenticated, not merely readable (proto S3/S5). */
    for (size_t i = 0; i < HCS_HEADER_LEN; i++) {
        uint8_t copy[HCS_MAX_DATAGRAM_LEN];
        memcpy(copy, dg, dg_len);
        copy[i] ^= 0x01;
        const int rc = ref_chacha20poly1305_open(
            key, &copy[HCS_HDR_OFF_NONCE], copy, HCS_HEADER_LEN,
            &copy[HCS_HEADER_LEN], sizeof pt,
            &copy[HCS_HEADER_LEN + sizeof pt], out);
        CHECK(rc != 0);
    }
}

static void test_seal_rejects_oversize_plaintext(void)
{
    static const uint8_t key[32] = { 0 };
    hcs_header_t h = { .version = 1, .msg_type = 1, .node_id = 1 };
    static uint8_t pt[HCS_MAX_PLAINTEXT_LEN + 1];
    uint8_t dg[HCS_MAX_DATAGRAM_LEN + 64];
    size_t dg_len = 0;
    CHECK_EQ_I64(hcs_datagram_seal(dg, sizeof dg, &dg_len, &h, pt, sizeof pt,
                                   key, ref_chacha20poly1305_seal, NULL),
                 HCS_ERR_TOO_LARGE);
}

static void test_seal_rejects_small_output_buffer(void)
{
    static const uint8_t key[32] = { 0 };
    hcs_header_t h = { .version = 1, .msg_type = 1, .node_id = 1 };
    const uint8_t pt[4] = { 1, 2, 3, 4 };
    uint8_t dg[HCS_HEADER_LEN + 4 + HCS_TAG_LEN - 1];
    size_t dg_len = 0;
    CHECK_EQ_I64(hcs_datagram_seal(dg, sizeof dg, &dg_len, &h, pt, sizeof pt,
                                   key, ref_chacha20poly1305_seal, NULL),
                 HCS_ERR_CAPACITY);
}

/* A datagram at exactly the 1200-byte protocol maximum must still seal. */
static void test_maximum_size_datagram_is_allowed(void)
{
    static const uint8_t key[32] = { 0x5A };
    hcs_header_t h = { .version = 1, .msg_type = 1, .node_id = 1 };
    static uint8_t pt[HCS_MAX_PLAINTEXT_LEN];
    uint8_t dg[HCS_MAX_DATAGRAM_LEN];
    size_t dg_len = 0;
    CHECK_EQ_I64(hcs_datagram_seal(dg, sizeof dg, &dg_len, &h, pt, sizeof pt,
                                   key, ref_chacha20poly1305_seal, NULL),
                 HCS_OK);
    CHECK_EQ_U64(dg_len, HCS_MAX_DATAGRAM_LEN);
}

int main(void)
{
    TEST_SUITE("aead + datagram seal (S2/S5)");
    test_rfc8439_aead_vector();
    test_tampering_is_detected();
    test_empty_plaintext_still_authenticates_aad();
    test_datagram_seal_uses_header_as_aad();
    test_seal_rejects_oversize_plaintext();
    test_seal_rejects_small_output_buffer();
    test_maximum_size_datagram_is_allowed();
    return hcs_test_report();
}
