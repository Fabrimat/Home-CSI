/*
 * csi_codec.h - encode/decode the Home CSI v1 wire format (docs/protocol.md).
 *
 * Shared between the ESP-IDF firmware and the host tests. Pure C11, no
 * allocation, no ESP-IDF dependency, no crypto implementation: the AEAD is
 * injected as a function pointer so the firmware can use mbedTLS while the
 * host tests use a small reference implementation.
 */
#ifndef CSI_PROTOCOL_CSI_CODEC_H
#define CSI_PROTOCOL_CSI_CODEC_H

#include "csi_protocol/csi_wire.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Build the 12-byte AEAD nonce exactly as specified in proto S4:
 *   node_id(u16 LE) || boot_epoch(u32 LE) || seq(u32 LE) || 00 00
 * Uniqueness for a given key is structural: it holds as long as seq strictly
 * increases within a boot_epoch and boot_epoch strictly increases across
 * reboots. Both invariants are owned by seq_epoch.h / boot_epoch.c. */
void hcs_nonce_build(uint8_t out[HCS_NONCE_LEN], uint16_t node_id,
                     uint32_t boot_epoch, uint32_t seq);

/* Encode the 28-byte cleartext header (proto S3), including the nonce field.
 * Returns the number of bytes written (HCS_HEADER_LEN) or 0 if cap is too
 * small. `magic` and `nonce` are filled in by this function; the caller only
 * supplies the identity fields. */
size_t hcs_header_encode(uint8_t *out, size_t cap, const hcs_header_t *h);

/* Decode and *verify* a 28-byte cleartext header. Performs the checks the
 * protocol requires of a decoder before any crypto: magic, and the nonce
 * recomputation of proto S4 (including the two reserved zero bytes).
 * Version is returned, not enforced, so the caller can count version
 * mismatches per proto S12. */
hcs_err_t hcs_header_decode(hcs_header_t *out, const uint8_t *in, size_t len);

/* Encode the 22-byte batch header (proto S9.1). Returns bytes written or 0. */
size_t hcs_batch_header_encode(uint8_t *out, size_t cap,
                               const hcs_batch_header_t *bh);

/* Encode one CSI record: 31 fixed bytes + csi_len raw bytes (proto S9.2).
 * Returns total bytes written, or 0 if cap is too small. */
size_t hcs_record_encode(uint8_t *out, size_t cap, const hcs_csi_record_t *r);

/* Encode the 36-byte heartbeat payload (proto S10). Returns bytes or 0. */
size_t hcs_heartbeat_encode(uint8_t *out, size_t cap,
                            const hcs_heartbeat_t *hb);

/* AEAD seal callback. Must implement ChaCha20-Poly1305 (IETF) per proto S5.
 * Returns 0 on success, non-zero on failure. ct_out may alias pt. */
typedef int (*hcs_aead_seal_fn)(void *ctx, const uint8_t key[HCS_KEY_LEN],
                                const uint8_t nonce[HCS_NONCE_LEN],
                                const uint8_t *aad, size_t aad_len,
                                const uint8_t *pt, size_t pt_len,
                                uint8_t *ct_out, uint8_t tag_out[HCS_TAG_LEN]);

/* Assemble a complete datagram: header || ciphertext || tag (proto S2).
 * The 28-byte header is passed to the AEAD as AAD exactly as it appears on
 * the wire (proto S5). Enforces the 1200-byte maximum of proto S11.
 * On success writes *out_len and returns HCS_OK. */
hcs_err_t hcs_datagram_seal(uint8_t *out, size_t out_cap, size_t *out_len,
                            const hcs_header_t *hdr, const uint8_t *plaintext,
                            size_t pt_len, const uint8_t key[HCS_KEY_LEN],
                            hcs_aead_seal_fn seal, void *seal_ctx);

/* Little-endian primitive writers, exposed because several modules need them
 * and the protocol says "all multi-byte integers are little-endian" exactly
 * once, here. */
void hcs_put_u16le(uint8_t *p, uint16_t v);
void hcs_put_u32le(uint8_t *p, uint32_t v);
void hcs_put_u64le(uint8_t *p, uint64_t v);
uint16_t hcs_get_u16le(const uint8_t *p);
uint32_t hcs_get_u32le(const uint8_t *p);
uint64_t hcs_get_u64le(const uint8_t *p);

#ifdef __cplusplus
}
#endif

#endif /* CSI_PROTOCOL_CSI_CODEC_H */
