/*
 * test_device_token.c - the device-API bearer token of the OTA/hello contract.
 *
 * ============================ READ THIS ==============================
 * The token is
 *
 *   device_token = base64url_nopad(
 *                      HMAC-SHA256(key = psk_raw_32_bytes,
 *                                  msg = "homecsi-device-v1"))
 *
 * and it is derived on BOTH sides: here, by the firmware's
 * components/csi_protocol/device_token.c (the same file the ESP-IDF build
 * compiles), and on the server by its own independent implementation.
 *
 * The vector below is therefore HARDCODED, not recomputed. The proof of
 * correctness is that two independently written implementations agree with
 * the same literal - the same philosophy as test_docs_example.c. If this
 * test ever fails, DO NOT update the literal: the firmware and the server
 * have diverged, and every node's Authorization header is about to be
 * rejected.
 *
 * The HMAC primitive itself is injected (support/ref_hmac_sha256.c on the
 * host, mbedTLS on the device) exactly the way hcs_datagram_seal() takes an
 * hcs_aead_seal_fn, so this test exercises the real derivation and only the
 * primitive differs. The primitive is pinned separately against RFC 4231, so
 * a bug in it reads as "reference HMAC is wrong" rather than as a mystery.
 * =====================================================================
 */
#include "harness.h"

#include "csi_protocol/device_token.h"
#include "ref_hmac_sha256.h"

/* --- the contract's golden vector, verbatim --------------------------- */

/* psk = 0x00 0x01 0x02 ... 0x1f */
static const uint8_t GOLDEN_PSK[HCS_KEY_LEN] = {
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
    0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
    0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f
};

static const uint8_t GOLDEN_HMAC[32] = {
    0xbe, 0x76, 0x45, 0xfc, 0x0b, 0x07, 0xdb, 0x5d, 0x06, 0x9e, 0xf9,
    0x9a, 0x63, 0x37, 0xf3, 0xa1, 0xa9, 0x7b, 0xeb, 0xa5, 0xd2, 0x8f,
    0xde, 0x08, 0x4f, 0xae, 0x65, 0xe3, 0x1c, 0x18, 0x9b, 0x5f
};

static const char GOLDEN_TOKEN[] = "vnZF_AsH210GnvmaYzfzoal766XSj94IT65l4xwYm18";

/* Second vector, present only because the golden one above happens to
 * contain a '_' but no '-', which would leave half of the base64url
 * alphabet substitution unproven. psk = 0x02 repeated 32 times.
 *
 * PROVENANCE: python3
 *   base64.urlsafe_b64encode(hmac.new(bytes([2])*32, b'homecsi-device-v1',
 *                                     hashlib.sha256).digest())
 * i.e. the stdlib, not this C code. It is a coverage vector, not part of the
 * fixed contract - the one above is the contract. */
static const uint8_t ALPHABET_PSK[HCS_KEY_LEN] = {
    0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
    0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
    0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02
};
static const char ALPHABET_TOKEN[] =
    "e245OPZNy2v1PuJq-wLkR9WiG2Vs_5WkTD6EgWK62d4";

/* --- the reference HMAC, pinned against RFC 4231 ---------------------- */

static void test_reference_primitive_matches_rfc(void)
{
    /* FIPS 180-4 / the canonical SHA-256("abc"). If this fails, nothing
     * below means anything. */
    static const uint8_t sha_abc[32] = {
        0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40,
        0xde, 0x5d, 0xae, 0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17,
        0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad
    };
    uint8_t got[32];
    ref_sha256((const uint8_t *)"abc", 3, got);
    CHECK_BYTES(got, sha_abc, sizeof sha_abc);

    /* RFC 4231 section 4.2 (test case 1). */
    uint8_t key1[20];
    memset(key1, 0x0b, sizeof key1);
    static const uint8_t tc1[32] = {
        0xb0, 0x34, 0x4c, 0x61, 0xd8, 0xdb, 0x38, 0x53, 0x5c, 0xa8, 0xaf,
        0xce, 0xaf, 0x0b, 0xf1, 0x2b, 0x88, 0x1d, 0xc2, 0x00, 0xc9, 0x83,
        0x3d, 0xa7, 0x26, 0xe9, 0x37, 0x6c, 0x2e, 0x32, 0xcf, 0xf7
    };
    CHECK_EQ_I64(ref_hmac_sha256(NULL, key1, sizeof key1,
                                 (const uint8_t *)"Hi There", 8, got),
                 0);
    CHECK_BYTES(got, tc1, sizeof tc1);

    /* RFC 4231 section 4.3 (test case 2): short key. */
    static const uint8_t tc2[32] = {
        0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e, 0x6a, 0x04, 0x24,
        0x26, 0x08, 0x95, 0x75, 0xc7, 0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27,
        0x39, 0x83, 0x9d, 0xec, 0x58, 0xb9, 0x64, 0xec, 0x38, 0x43
    };
    CHECK_EQ_I64(
        ref_hmac_sha256(NULL, (const uint8_t *)"Jefe", 4,
                        (const uint8_t *)"what do ya want for nothing?", 28,
                        got),
        0);
    CHECK_BYTES(got, tc2, sizeof tc2);

    /* RFC 4231 section 4.7 (test case 6): key longer than the 64-byte block,
     * which is the only path that hashes the key first. Our PSK is 32 bytes
     * so the firmware never takes it, but an untested branch in a crypto
     * helper is how a "reference" implementation quietly stops being one. */
    uint8_t key6[131];
    memset(key6, 0xaa, sizeof key6);
    static const uint8_t tc6[32] = {
        0x60, 0xe4, 0x31, 0x59, 0x1e, 0xe0, 0xb6, 0x7f, 0x0d, 0x8a, 0x26,
        0xaa, 0xcb, 0xf5, 0xb7, 0x7f, 0x8e, 0x0b, 0xc6, 0x21, 0x37, 0x28,
        0xc5, 0x14, 0x05, 0x46, 0x04, 0x0f, 0x0e, 0xe3, 0x7f, 0x54
    };
    CHECK_EQ_I64(
        ref_hmac_sha256(
            NULL, key6, sizeof key6,
            (const uint8_t *)"Test Using Larger Than Block-Size Key - Hash "
                             "Key First",
            54, got),
        0);
    CHECK_BYTES(got, tc6, sizeof tc6);
}

/* --- the label -------------------------------------------------------- */

static void test_label_is_exact(void)
{
    /* Exact ASCII, no trailing newline, no NUL in the HMAC message. The
     * server hashes the same 17 bytes; one stray byte here and every node in
     * the fleet gets a 401. */
    CHECK(strcmp(HCS_DEVICE_TOKEN_LABEL, "homecsi-device-v1") == 0);
    CHECK_EQ_U64(sizeof(HCS_DEVICE_TOKEN_LABEL) - 1u, 17u);
}

/* --- the golden vector ------------------------------------------------ */

static void test_golden_vector(void)
{
    /* The HMAC step alone, so a failure says whether the primitive or the
     * base64url step is at fault. */
    uint8_t mac[32];
    CHECK_EQ_I64(ref_hmac_sha256(NULL, GOLDEN_PSK, HCS_KEY_LEN,
                                 (const uint8_t *)HCS_DEVICE_TOKEN_LABEL,
                                 sizeof(HCS_DEVICE_TOKEN_LABEL) - 1u, mac),
                 0);
    CHECK_BYTES(mac, GOLDEN_HMAC, sizeof GOLDEN_HMAC);

    char token[HCS_DEVICE_TOKEN_BUF_LEN];
    CHECK_EQ_I64(hcs_device_token_derive(token, sizeof token, GOLDEN_PSK,
                                         ref_hmac_sha256, NULL),
                 HCS_OK);
    CHECK(strcmp(token, GOLDEN_TOKEN) == 0);
    if (strcmp(token, GOLDEN_TOKEN) != 0) {
        printf("  got  '%s'\n  want '%s'\n", token, GOLDEN_TOKEN);
    }
}

/* --- base64url shape -------------------------------------------------- */

static void test_base64url_no_padding_and_url_alphabet(void)
{
    char token[HCS_DEVICE_TOKEN_BUF_LEN];
    CHECK_EQ_I64(hcs_device_token_derive(token, sizeof token, ALPHABET_PSK,
                                         ref_hmac_sha256, NULL),
                 HCS_OK);
    CHECK(strcmp(token, ALPHABET_TOKEN) == 0);
    if (strcmp(token, ALPHABET_TOKEN) != 0) {
        printf("  got  '%s'\n  want '%s'\n", token, ALPHABET_TOKEN);
    }

    /* This vector was picked because it exercises BOTH substituted
     * characters; if it stops doing so the shape checks below go blind. */
    CHECK(strchr(ALPHABET_TOKEN, '-') != NULL);
    CHECK(strchr(ALPHABET_TOKEN, '_') != NULL);

    /* 32 bytes -> 43 characters, and no '=' padding. */
    CHECK_EQ_U64(strlen(token), HCS_DEVICE_TOKEN_LEN);
    CHECK_EQ_U64(HCS_DEVICE_TOKEN_LEN, 43u);
    CHECK(strchr(token, '=') == NULL);

    /* Standard-base64 characters must never appear: they are not URL- or
     * header-safe, which is the whole reason for base64url. */
    CHECK(strchr(token, '+') == NULL);
    CHECK(strchr(token, '/') == NULL);

    /* And every character must be in the base64url alphabet. */
    for (size_t i = 0; token[i] != '\0'; i++) {
        const char c = token[i];
        const int ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                       || (c >= '0' && c <= '9') || c == '-' || c == '_';
        CHECK(ok);
    }
}

/* --- argument handling ------------------------------------------------ */

static void test_rejects_bad_arguments(void)
{
    char token[HCS_DEVICE_TOKEN_BUF_LEN];

    CHECK_EQ_I64(hcs_device_token_derive(NULL, sizeof token, GOLDEN_PSK,
                                         ref_hmac_sha256, NULL),
                 HCS_ERR_ARG);
    CHECK_EQ_I64(hcs_device_token_derive(token, sizeof token, NULL,
                                         ref_hmac_sha256, NULL),
                 HCS_ERR_ARG);
    CHECK_EQ_I64(
        hcs_device_token_derive(token, sizeof token, GOLDEN_PSK, NULL, NULL),
        HCS_ERR_ARG);

    /* One byte short of "43 characters plus a NUL" must fail rather than
     * emit a silently truncated token that the server would reject. */
    CHECK_EQ_I64(hcs_device_token_derive(token, HCS_DEVICE_TOKEN_LEN,
                                         GOLDEN_PSK, ref_hmac_sha256, NULL),
                 HCS_ERR_CAPACITY);
}

static int failing_hmac(void *ctx, const uint8_t *key, size_t key_len,
                        const uint8_t *msg, size_t msg_len, uint8_t out[32])
{
    (void)ctx;
    (void)key;
    (void)key_len;
    (void)msg;
    (void)msg_len;
    (void)out;
    return -1;
}

static void test_propagates_primitive_failure(void)
{
    /* mbedTLS can fail (out of memory, unavailable hardware SHA). It must
     * not be mistaken for a valid token. */
    char token[HCS_DEVICE_TOKEN_BUF_LEN];
    memset(token, 'x', sizeof token);
    CHECK_EQ_I64(hcs_device_token_derive(token, sizeof token, GOLDEN_PSK,
                                         failing_hmac, NULL),
                 HCS_ERR_CRYPTO);
    /* And the caller's buffer must not be left holding a plausible-looking
     * string on failure. */
    CHECK(token[0] == '\0');
}

int main(void)
{
    TEST_SUITE("device token (OTA/hello auth)");
    test_reference_primitive_matches_rfc();
    test_label_is_exact();
    test_golden_vector();
    test_base64url_no_padding_and_url_alphabet();
    test_rejects_bad_arguments();
    test_propagates_primitive_failure();
    return hcs_test_report();
}
