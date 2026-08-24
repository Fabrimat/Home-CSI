/*
 * ref_hmac_sha256.h - HOST-TEST-ONLY reference SHA-256 / HMAC-SHA256
 * (FIPS 180-4 / RFC 2104).
 *
 * !! THIS IS NOT FIRMWARE CODE AND IS NEVER COMPILED INTO THE FIRMWARE. !!
 * The node uses mbedTLS (bundled with ESP-IDF) via main/ota.c. This copy
 * exists only so the host tests can exercise the SAME
 * components/csi_protocol/device_token.c the firmware compiles, without
 * pulling a crypto library into the host build - exactly the arrangement
 * ref_chacha20poly1305.c has for the AEAD.
 *
 * It is validated in test_device_token.c against the RFC 4231 HMAC-SHA256
 * test vectors, so a bug in here shows up as a named failure rather than as
 * a mysteriously wrong device token.
 * It is straightforward, not constant-time, and not hardened.
 */
#ifndef HCS_REF_HMAC_SHA256_H
#define HCS_REF_HMAC_SHA256_H

#include <stddef.h>
#include <stdint.h>

/* Plain SHA-256 of `msg`. */
void ref_sha256(const uint8_t *msg, size_t msg_len, uint8_t out[32]);

/* Matches hcs_hmac_sha256_fn so it can be handed straight to
 * hcs_device_token_derive(). ctx is ignored. Returns 0 on success. */
int ref_hmac_sha256(void *ctx, const uint8_t *key, size_t key_len,
                    const uint8_t *msg, size_t msg_len, uint8_t out[32]);

#endif /* HCS_REF_HMAC_SHA256_H */
