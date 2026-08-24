/* device_token.c - see device_token.h. */

#include "csi_protocol/device_token.h"

#include <string.h>

/* base64url (RFC 4648 section 5): the standard alphabet with '+' -> '-' and
 * '/' -> '_', so the result is safe in a URL and in an HTTP header value.
 *
 * Declared without an explicit bound: spelling it [64] makes the literal
 * exactly fill the array with no room for its NUL, which some compilers
 * (clang 17+, and therefore `zig cc`) reject outright under -Werror. Only
 * indices 0..63 are ever read. */
static const char B64URL[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

hcs_err_t hcs_device_token_derive(char *out, size_t out_cap,
                                  const uint8_t psk[HCS_KEY_LEN],
                                  hcs_hmac_sha256_fn hmac, void *hmac_ctx)
{
    if (out == NULL || psk == NULL || hmac == NULL) {
        return HCS_ERR_ARG;
    }
    if (out_cap < HCS_DEVICE_TOKEN_BUF_LEN) {
        return HCS_ERR_CAPACITY;
    }
    out[0] = '\0'; /* nothing partial escapes, whatever happens below */

    uint8_t mac[32];
    if (hmac(hmac_ctx, psk, HCS_KEY_LEN,
             (const uint8_t *)HCS_DEVICE_TOKEN_LABEL,
             sizeof(HCS_DEVICE_TOKEN_LABEL) - 1u, mac)
        != 0) {
        return HCS_ERR_CRYPTO;
    }

    /* 32 bytes = ten whole 3-byte groups (40 chars) plus a 2-byte remainder
     * (3 chars) = 43 chars. Padding is omitted, per the contract. */
    size_t o = 0;
    size_t i = 0;
    for (; i + 3u <= sizeof mac; i += 3u) {
        const uint32_t v = ((uint32_t)mac[i] << 16)
                           | ((uint32_t)mac[i + 1u] << 8)
                           | (uint32_t)mac[i + 2u];
        out[o++] = B64URL[(v >> 18) & 0x3fu];
        out[o++] = B64URL[(v >> 12) & 0x3fu];
        out[o++] = B64URL[(v >> 6) & 0x3fu];
        out[o++] = B64URL[v & 0x3fu];
    }
    /* The remainder is always 2 for a 32-byte digest, but both tails are
     * handled so this stays a correct base64url encoder rather than a
     * constant-length trick that breaks if the digest ever changes. */
    const size_t rem = sizeof mac - i;
    if (rem == 1u) {
        const uint32_t v = (uint32_t)mac[i] << 16;
        out[o++] = B64URL[(v >> 18) & 0x3fu];
        out[o++] = B64URL[(v >> 12) & 0x3fu];
    } else if (rem == 2u) {
        const uint32_t v =
            ((uint32_t)mac[i] << 16) | ((uint32_t)mac[i + 1u] << 8);
        out[o++] = B64URL[(v >> 18) & 0x3fu];
        out[o++] = B64URL[(v >> 12) & 0x3fu];
        out[o++] = B64URL[(v >> 6) & 0x3fu];
    }
    out[o] = '\0';

    /* The digest is not the key, but it is the credential; do not leave it on
     * the stack for the next function to inherit. */
    memset(mac, 0, sizeof mac);

    return (o == HCS_DEVICE_TOKEN_LEN) ? HCS_OK : HCS_ERR_CAPACITY;
}
