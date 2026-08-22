/*
 * ref_chacha20poly1305.h - HOST-TEST-ONLY reference ChaCha20-Poly1305 (IETF,
 * RFC 8439).
 *
 * !! THIS IS NOT FIRMWARE CODE AND IS NEVER COMPILED INTO THE FIRMWARE. !!
 * The node uses mbedTLS (bundled with ESP-IDF) via main/crypto.c. This copy
 * exists only so the host tests can produce and check real sealed datagram
 * bytes without pulling in a crypto library, and so the shared codec's AEAD
 * injection point is exercised end to end.
 *
 * It is validated in test_crypto.c against the RFC 8439 section 2.8.2 test
 * vector, and (out of band) against Node's built-in chacha20-poly1305.
 * It is straightforward, not constant-time, and not hardened.
 */
#ifndef HCS_REF_CHACHA20POLY1305_H
#define HCS_REF_CHACHA20POLY1305_H

#include <stddef.h>
#include <stdint.h>

/* Matches hcs_aead_seal_fn so it can be handed straight to
 * hcs_datagram_seal(). ctx is ignored. Returns 0 on success. */
int ref_chacha20poly1305_seal(void *ctx, const uint8_t key[32],
                              const uint8_t nonce[12], const uint8_t *aad,
                              size_t aad_len, const uint8_t *pt, size_t pt_len,
                              uint8_t *ct_out, uint8_t tag_out[16]);

/* Returns 0 when the tag verifies and pt_out is filled, non-zero otherwise. */
int ref_chacha20poly1305_open(const uint8_t key[32], const uint8_t nonce[12],
                              const uint8_t *aad, size_t aad_len,
                              const uint8_t *ct, size_t ct_len,
                              const uint8_t tag[16], uint8_t *pt_out);

#endif /* HCS_REF_CHACHA20POLY1305_H */
