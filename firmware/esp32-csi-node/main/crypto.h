/*
 * crypto.h - ChaCha20-Poly1305 AEAD via mbedTLS (docs/protocol.md S5).
 *
 * The nonce and AAD construction do NOT live here: they are part of the wire
 * format and live in components/csi_protocol/csi_codec.c, which is shared
 * with the host tests. This module is only the primitive, plugged into
 * hcs_datagram_seal() as an hcs_aead_seal_fn.
 */
#ifndef HCS_CRYPTO_H
#define HCS_CRYPTO_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"
#include "mbedtls/chachapoly.h"

#include "csi_protocol/csi_wire.h"

typedef struct {
    mbedtls_chachapoly_context ctx;
    bool ready;
} hcs_crypto_t;

/* Binds the node's 32-byte PSK. The key is copied into the mbedTLS context
 * and the caller's copy can be wiped afterwards. */
esp_err_t hcs_crypto_init(hcs_crypto_t *c, const uint8_t psk[HCS_KEY_LEN]);

/* Zeroises the key material. */
void hcs_crypto_deinit(hcs_crypto_t *c);

/* hcs_aead_seal_fn: pass this, with the hcs_crypto_t* as ctx, to
 * hcs_datagram_seal(). The `key` argument is ignored - the key is already
 * bound - and is asserted to be the one we were initialised with only in the
 * sense that callers must not pass a different one. */
int hcs_crypto_seal(void *ctx, const uint8_t key[HCS_KEY_LEN],
                    const uint8_t nonce[HCS_NONCE_LEN], const uint8_t *aad,
                    size_t aad_len, const uint8_t *pt, size_t pt_len,
                    uint8_t *ct_out, uint8_t tag_out[HCS_TAG_LEN]);

#endif /* HCS_CRYPTO_H */
