/* ref_chacha20poly1305.c - HOST-TEST-ONLY. See the header for why this
 * exists and why it must never end up in the firmware image. */

#include "ref_chacha20poly1305.h"

#include <string.h>

/* --- little-endian helpers ------------------------------------------- */

static uint32_t ld32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16)
           | ((uint32_t)p[3] << 24);
}

static void st32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

/* --- ChaCha20 (RFC 8439 section 2.3) ---------------------------------- */

static uint32_t rotl32(uint32_t v, int n)
{
    return (v << n) | (v >> (32 - n));
}

#define QR(a, b, c, d)                                                         \
    do {                                                                       \
        a += b; d ^= a; d = rotl32(d, 16);                                     \
        c += d; b ^= c; b = rotl32(b, 12);                                     \
        a += b; d ^= a; d = rotl32(d, 8);                                      \
        c += d; b ^= c; b = rotl32(b, 7);                                      \
    } while (0)

static void chacha20_block(const uint8_t key[32], uint32_t counter,
                           const uint8_t nonce[12], uint8_t out[64])
{
    uint32_t s[16];
    s[0] = 0x61707865u; /* "expa" */
    s[1] = 0x3320646eu; /* "nd 3" */
    s[2] = 0x79622d32u; /* "2-by" */
    s[3] = 0x6b206574u; /* "te k" */
    for (int i = 0; i < 8; i++) {
        s[4 + i] = ld32(&key[4 * i]);
    }
    s[12] = counter;
    s[13] = ld32(&nonce[0]);
    s[14] = ld32(&nonce[4]);
    s[15] = ld32(&nonce[8]);

    uint32_t x[16];
    memcpy(x, s, sizeof x);
    for (int i = 0; i < 10; i++) {
        QR(x[0], x[4], x[8], x[12]);
        QR(x[1], x[5], x[9], x[13]);
        QR(x[2], x[6], x[10], x[14]);
        QR(x[3], x[7], x[11], x[15]);
        QR(x[0], x[5], x[10], x[15]);
        QR(x[1], x[6], x[11], x[12]);
        QR(x[2], x[7], x[8], x[13]);
        QR(x[3], x[4], x[9], x[14]);
    }
    for (int i = 0; i < 16; i++) {
        st32(&out[4 * i], x[i] + s[i]);
    }
}

static void chacha20_xor(const uint8_t key[32], uint32_t counter,
                         const uint8_t nonce[12], const uint8_t *in,
                         uint8_t *out, size_t len)
{
    uint8_t block[64];
    size_t off = 0;
    while (off < len) {
        chacha20_block(key, counter, nonce, block);
        const size_t n = (len - off < 64) ? (len - off) : 64;
        for (size_t i = 0; i < n; i++) {
            out[off + i] = (uint8_t)(in[off + i] ^ block[i]);
        }
        off += n;
        counter++;
    }
}

/* --- Poly1305 (RFC 8439 section 2.5), 26-bit limb implementation ------ */

typedef struct {
    uint32_t r[5];
    uint32_t h[5];
    uint32_t pad[4];
    size_t leftover;
    uint8_t buffer[16];
    uint8_t final;
} poly1305_t;

static void poly1305_init(poly1305_t *st, const uint8_t key[32])
{
    st->r[0] = (ld32(&key[0])) & 0x3ffffffu;
    st->r[1] = (ld32(&key[3]) >> 2) & 0x3ffff03u;
    st->r[2] = (ld32(&key[6]) >> 4) & 0x3ffc0ffu;
    st->r[3] = (ld32(&key[9]) >> 6) & 0x3f03fffu;
    st->r[4] = (ld32(&key[12]) >> 8) & 0x00fffffu;
    for (int i = 0; i < 5; i++) {
        st->h[i] = 0;
    }
    for (int i = 0; i < 4; i++) {
        st->pad[i] = ld32(&key[16 + 4 * i]);
    }
    st->leftover = 0;
    st->final = 0;
    memset(st->buffer, 0, sizeof st->buffer);
}

static void poly1305_blocks(poly1305_t *st, const uint8_t *m, size_t bytes)
{
    const uint32_t hibit = st->final ? 0u : (1u << 24);
    const uint32_t r0 = st->r[0], r1 = st->r[1], r2 = st->r[2], r3 = st->r[3],
                   r4 = st->r[4];
    const uint32_t s1 = r1 * 5u, s2 = r2 * 5u, s3 = r3 * 5u, s4 = r4 * 5u;
    uint32_t h0 = st->h[0], h1 = st->h[1], h2 = st->h[2], h3 = st->h[3],
             h4 = st->h[4];

    while (bytes >= 16) {
        h0 += (ld32(m + 0)) & 0x3ffffffu;
        h1 += (ld32(m + 3) >> 2) & 0x3ffffffu;
        h2 += (ld32(m + 6) >> 4) & 0x3ffffffu;
        h3 += (ld32(m + 9) >> 6) & 0x3ffffffu;
        h4 += (ld32(m + 12) >> 8) | hibit;

        uint64_t d0 = (uint64_t)h0 * r0 + (uint64_t)h1 * s4 + (uint64_t)h2 * s3
                      + (uint64_t)h3 * s2 + (uint64_t)h4 * s1;
        uint64_t d1 = (uint64_t)h0 * r1 + (uint64_t)h1 * r0 + (uint64_t)h2 * s4
                      + (uint64_t)h3 * s3 + (uint64_t)h4 * s2;
        uint64_t d2 = (uint64_t)h0 * r2 + (uint64_t)h1 * r1 + (uint64_t)h2 * r0
                      + (uint64_t)h3 * s4 + (uint64_t)h4 * s3;
        uint64_t d3 = (uint64_t)h0 * r3 + (uint64_t)h1 * r2 + (uint64_t)h2 * r1
                      + (uint64_t)h3 * r0 + (uint64_t)h4 * s4;
        uint64_t d4 = (uint64_t)h0 * r4 + (uint64_t)h1 * r3 + (uint64_t)h2 * r2
                      + (uint64_t)h3 * r1 + (uint64_t)h4 * r0;

        uint32_t c = (uint32_t)(d0 >> 26);
        h0 = (uint32_t)d0 & 0x3ffffffu;
        d1 += c;
        c = (uint32_t)(d1 >> 26);
        h1 = (uint32_t)d1 & 0x3ffffffu;
        d2 += c;
        c = (uint32_t)(d2 >> 26);
        h2 = (uint32_t)d2 & 0x3ffffffu;
        d3 += c;
        c = (uint32_t)(d3 >> 26);
        h3 = (uint32_t)d3 & 0x3ffffffu;
        d4 += c;
        c = (uint32_t)(d4 >> 26);
        h4 = (uint32_t)d4 & 0x3ffffffu;
        h0 += c * 5u;
        c = h0 >> 26;
        h0 &= 0x3ffffffu;
        h1 += c;

        m += 16;
        bytes -= 16;
    }

    st->h[0] = h0;
    st->h[1] = h1;
    st->h[2] = h2;
    st->h[3] = h3;
    st->h[4] = h4;
}

static void poly1305_update(poly1305_t *st, const uint8_t *m, size_t bytes)
{
    if (st->leftover) {
        size_t want = 16 - st->leftover;
        if (want > bytes) {
            want = bytes;
        }
        memcpy(st->buffer + st->leftover, m, want);
        bytes -= want;
        m += want;
        st->leftover += want;
        if (st->leftover < 16) {
            return;
        }
        poly1305_blocks(st, st->buffer, 16);
        st->leftover = 0;
    }
    if (bytes >= 16) {
        const size_t want = bytes & ~((size_t)15);
        poly1305_blocks(st, m, want);
        m += want;
        bytes -= want;
    }
    if (bytes) {
        memcpy(st->buffer + st->leftover, m, bytes);
        st->leftover += bytes;
    }
}

static void poly1305_finish(poly1305_t *st, uint8_t mac[16])
{
    if (st->leftover) {
        size_t i = st->leftover;
        st->buffer[i++] = 1;
        for (; i < 16; i++) {
            st->buffer[i] = 0;
        }
        st->final = 1;
        poly1305_blocks(st, st->buffer, 16);
    }

    uint32_t h0 = st->h[0], h1 = st->h[1], h2 = st->h[2], h3 = st->h[3],
             h4 = st->h[4];
    uint32_t c = h1 >> 26;
    h1 &= 0x3ffffffu;
    h2 += c;
    c = h2 >> 26;
    h2 &= 0x3ffffffu;
    h3 += c;
    c = h3 >> 26;
    h3 &= 0x3ffffffu;
    h4 += c;
    c = h4 >> 26;
    h4 &= 0x3ffffffu;
    h0 += c * 5u;
    c = h0 >> 26;
    h0 &= 0x3ffffffu;
    h1 += c;

    uint32_t g0 = h0 + 5u;
    c = g0 >> 26;
    g0 &= 0x3ffffffu;
    uint32_t g1 = h1 + c;
    c = g1 >> 26;
    g1 &= 0x3ffffffu;
    uint32_t g2 = h2 + c;
    c = g2 >> 26;
    g2 &= 0x3ffffffu;
    uint32_t g3 = h3 + c;
    c = g3 >> 26;
    g3 &= 0x3ffffffu;
    uint32_t g4 = h4 + c - (1u << 26);

    uint32_t mask = (g4 >> 31) - 1u; /* 0 if borrow (h < p), else all ones */
    g0 &= mask;
    g1 &= mask;
    g2 &= mask;
    g3 &= mask;
    g4 &= mask;
    mask = ~mask;
    h0 = (h0 & mask) | g0;
    h1 = (h1 & mask) | g1;
    h2 = (h2 & mask) | g2;
    h3 = (h3 & mask) | g3;
    h4 = (h4 & mask) | g4;

    h0 = (h0 | (h1 << 26)) & 0xffffffffu;
    h1 = ((h1 >> 6) | (h2 << 20)) & 0xffffffffu;
    h2 = ((h2 >> 12) | (h3 << 14)) & 0xffffffffu;
    h3 = ((h3 >> 18) | (h4 << 8)) & 0xffffffffu;

    uint64_t f = (uint64_t)h0 + st->pad[0];
    h0 = (uint32_t)f;
    f = (uint64_t)h1 + st->pad[1] + (f >> 32);
    h1 = (uint32_t)f;
    f = (uint64_t)h2 + st->pad[2] + (f >> 32);
    h2 = (uint32_t)f;
    f = (uint64_t)h3 + st->pad[3] + (f >> 32);
    h3 = (uint32_t)f;

    st32(&mac[0], h0);
    st32(&mac[4], h1);
    st32(&mac[8], h2);
    st32(&mac[12], h3);
}

/* --- AEAD construction (RFC 8439 section 2.8) ------------------------- */

static void poly1305_pad16(poly1305_t *st, size_t len)
{
    static const uint8_t zeros[16] = { 0 };
    const size_t rem = len % 16u;
    if (rem != 0u) {
        poly1305_update(st, zeros, 16u - rem);
    }
}

static void aead_tag(const uint8_t key[32], const uint8_t nonce[12],
                     const uint8_t *aad, size_t aad_len, const uint8_t *ct,
                     size_t ct_len, uint8_t tag[16])
{
    uint8_t block0[64];
    chacha20_block(key, 0, nonce, block0);

    poly1305_t st;
    poly1305_init(&st, block0); /* first 32 bytes are the one-time key */

    if (aad_len) {
        poly1305_update(&st, aad, aad_len);
    }
    poly1305_pad16(&st, aad_len);
    if (ct_len) {
        poly1305_update(&st, ct, ct_len);
    }
    poly1305_pad16(&st, ct_len);

    uint8_t lens[16];
    for (int i = 0; i < 8; i++) {
        lens[i] = (uint8_t)(((uint64_t)aad_len >> (8 * i)) & 0xFFu);
        lens[8 + i] = (uint8_t)(((uint64_t)ct_len >> (8 * i)) & 0xFFu);
    }
    poly1305_update(&st, lens, 16);
    poly1305_finish(&st, tag);
}

int ref_chacha20poly1305_seal(void *ctx, const uint8_t key[32],
                              const uint8_t nonce[12], const uint8_t *aad,
                              size_t aad_len, const uint8_t *pt, size_t pt_len,
                              uint8_t *ct_out, uint8_t tag_out[16])
{
    (void)ctx;
    if (key == NULL || nonce == NULL || tag_out == NULL) {
        return -1;
    }
    if (pt_len != 0 && (pt == NULL || ct_out == NULL)) {
        return -1;
    }
    if (pt_len != 0) {
        chacha20_xor(key, 1, nonce, pt, ct_out, pt_len);
    }
    aead_tag(key, nonce, aad, aad_len, ct_out, pt_len, tag_out);
    return 0;
}

int ref_chacha20poly1305_open(const uint8_t key[32], const uint8_t nonce[12],
                              const uint8_t *aad, size_t aad_len,
                              const uint8_t *ct, size_t ct_len,
                              const uint8_t tag[16], uint8_t *pt_out)
{
    uint8_t expect[16];
    aead_tag(key, nonce, aad, aad_len, ct, ct_len, expect);
    uint8_t diff = 0;
    for (int i = 0; i < 16; i++) {
        diff |= (uint8_t)(expect[i] ^ tag[i]);
    }
    if (diff != 0) {
        return -1;
    }
    if (ct_len != 0) {
        chacha20_xor(key, 1, nonce, ct, pt_out, ct_len);
    }
    return 0;
}
