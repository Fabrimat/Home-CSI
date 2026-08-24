/* ref_hmac_sha256.c - HOST-TEST-ONLY. See the header for why this exists and
 * why it must never end up in the firmware image. */

#include "ref_hmac_sha256.h"

#include <string.h>

/* --- SHA-256 (FIPS 180-4) --------------------------------------------- */

static const uint32_t K[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu,
    0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u,
    0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u,
    0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u,
    0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
    0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u,
    0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u, 0x1e376c08u,
    0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu,
    0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

typedef struct {
    uint32_t h[8];
    uint8_t buf[64];
    size_t buf_len;
    uint64_t total_bytes;
} sha256_ctx_t;

static uint32_t rotr32(uint32_t v, int n)
{
    return (v >> n) | (v << (32 - n));
}

static uint32_t ld32be(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16)
           | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}

static void st32be(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

static void sha256_init(sha256_ctx_t *c)
{
    c->h[0] = 0x6a09e667u;
    c->h[1] = 0xbb67ae85u;
    c->h[2] = 0x3c6ef372u;
    c->h[3] = 0xa54ff53au;
    c->h[4] = 0x510e527fu;
    c->h[5] = 0x9b05688cu;
    c->h[6] = 0x1f83d9abu;
    c->h[7] = 0x5be0cd19u;
    c->buf_len = 0;
    c->total_bytes = 0;
}

static void sha256_block(sha256_ctx_t *c, const uint8_t block[64])
{
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ld32be(&block[i * 4]);
    }
    for (int i = 16; i < 64; i++) {
        const uint32_t s0 =
            rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        const uint32_t s1 =
            rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t a = c->h[0], b = c->h[1], cc = c->h[2], d = c->h[3];
    uint32_t e = c->h[4], f = c->h[5], g = c->h[6], h = c->h[7];

    for (int i = 0; i < 64; i++) {
        const uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        const uint32_t ch = (e & f) ^ ((~e) & g);
        const uint32_t t1 = h + S1 + ch + K[i] + w[i];
        const uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        const uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
        const uint32_t t2 = S0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = cc;
        cc = b;
        b = a;
        a = t1 + t2;
    }

    c->h[0] += a;
    c->h[1] += b;
    c->h[2] += cc;
    c->h[3] += d;
    c->h[4] += e;
    c->h[5] += f;
    c->h[6] += g;
    c->h[7] += h;
}

static void sha256_update(sha256_ctx_t *c, const uint8_t *p, size_t n)
{
    c->total_bytes += n;
    while (n > 0) {
        const size_t space = 64u - c->buf_len;
        const size_t take = (n < space) ? n : space;
        memcpy(&c->buf[c->buf_len], p, take);
        c->buf_len += take;
        p += take;
        n -= take;
        if (c->buf_len == 64u) {
            sha256_block(c, c->buf);
            c->buf_len = 0;
        }
    }
}

static void sha256_final(sha256_ctx_t *c, uint8_t out[32])
{
    const uint64_t bits = c->total_bytes * 8u;
    const uint8_t pad80 = 0x80u;
    const uint8_t zero = 0x00u;

    sha256_update(c, &pad80, 1);
    while (c->buf_len != 56u) {
        sha256_update(c, &zero, 1);
    }
    uint8_t len_be[8];
    st32be(&len_be[0], (uint32_t)(bits >> 32));
    st32be(&len_be[4], (uint32_t)bits);
    sha256_update(c, len_be, sizeof len_be);

    for (int i = 0; i < 8; i++) {
        st32be(&out[i * 4], c->h[i]);
    }
}

void ref_sha256(const uint8_t *msg, size_t msg_len, uint8_t out[32])
{
    sha256_ctx_t c;
    sha256_init(&c);
    sha256_update(&c, msg, msg_len);
    sha256_final(&c, out);
}

/* --- HMAC-SHA256 (RFC 2104) ------------------------------------------- */

int ref_hmac_sha256(void *ctx, const uint8_t *key, size_t key_len,
                    const uint8_t *msg, size_t msg_len, uint8_t out[32])
{
    (void)ctx;
    if (key == NULL || out == NULL) {
        return -1;
    }

    uint8_t k0[64];
    memset(k0, 0, sizeof k0);
    if (key_len > sizeof k0) {
        /* RFC 2104: keys longer than the block size are hashed first. */
        ref_sha256(key, key_len, k0);
    } else {
        memcpy(k0, key, key_len);
    }

    uint8_t ipad[64];
    uint8_t opad[64];
    for (size_t i = 0; i < sizeof k0; i++) {
        ipad[i] = (uint8_t)(k0[i] ^ 0x36u);
        opad[i] = (uint8_t)(k0[i] ^ 0x5cu);
    }

    sha256_ctx_t inner;
    sha256_init(&inner);
    sha256_update(&inner, ipad, sizeof ipad);
    if (msg_len > 0) {
        sha256_update(&inner, msg, msg_len);
    }
    uint8_t inner_digest[32];
    sha256_final(&inner, inner_digest);

    sha256_ctx_t outer;
    sha256_init(&outer);
    sha256_update(&outer, opad, sizeof opad);
    sha256_update(&outer, inner_digest, sizeof inner_digest);
    sha256_final(&outer, out);

    memset(k0, 0, sizeof k0);
    memset(ipad, 0, sizeof ipad);
    memset(opad, 0, sizeof opad);
    return 0;
}
