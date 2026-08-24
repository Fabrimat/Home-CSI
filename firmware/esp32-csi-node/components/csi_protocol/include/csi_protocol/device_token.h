/*
 * device_token.h - the bearer token the node presents to the device HTTP API
 * (/device/hello, /device/ota/manifest, /device/ota/firmware).
 *
 *   device_token = base64url_nopad(
 *                      HMAC-SHA256(key = psk_raw_32_bytes,
 *                                  msg = "homecsi-device-v1"))
 *
 * sent as `Authorization: Bearer <device_token>`.
 *
 * WHY IT LIVES HERE and not in main/: this is a shared contract, derived
 * identically by the node and by the server. Like the wire format in
 * csi_wire.h / csi_codec.c, it exists in exactly one place in this firmware,
 * and the host tests (firmware/tests/test_device_token.c) compile THIS file -
 * not a copy of it - against a hardcoded golden vector that the server's own
 * test also hardcodes. Two independent implementations agreeing on one
 * literal is the proof; a copy in main/ would only prove the copy matches
 * itself.
 *
 * WHY THE PRIMITIVE IS INJECTED: mbedTLS is not available to the host tests,
 * so the HMAC-SHA256 function is a parameter, exactly as hcs_datagram_seal()
 * takes an hcs_aead_seal_fn. On the device that is mbedTLS (main/ota.c); on
 * the host it is firmware/tests/support/ref_hmac_sha256.c. This header stays
 * free of any ESP-IDF, FreeRTOS or mbedTLS dependency: plain C11 only.
 *
 * KEY MATERIAL: the HMAC key is the RAW 32 bytes of the PSK, which is exactly
 * what NVS stores and what node_config_t.psk holds. NOT its base64 or hex
 * rendering. Hashing a rendering instead would still produce a stable
 * 43-character token that simply never matches the server's - the most
 * annoying possible failure mode, so it is stated here and pinned by a test.
 *
 * The token is derived from the PSK but is NOT the PSK: it is a fixed-label
 * one-way function of it, so a token leaking from an HTTP log does not
 * disclose the key that decrypts the node's CSI stream. It does, however,
 * fully authenticate as that node, so treat it as a credential.
 */
#ifndef CSI_PROTOCOL_DEVICE_TOKEN_H
#define CSI_PROTOCOL_DEVICE_TOKEN_H

#include <stddef.h>
#include <stdint.h>

#include "csi_protocol/csi_wire.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Exact ASCII, 17 bytes, no trailing newline and no NUL in the HMAC message.
 * Versioned so a future token scheme can coexist rather than silently
 * invalidating a provisioned fleet. */
#define HCS_DEVICE_TOKEN_LABEL "homecsi-device-v1"

/* base64url of a 32-byte digest with the padding stripped: 43 characters. */
#define HCS_DEVICE_TOKEN_LEN 43u
#define HCS_DEVICE_TOKEN_BUF_LEN (HCS_DEVICE_TOKEN_LEN + 1u)

/* The injected primitive. Must write the 32-byte HMAC-SHA256 of
 * (key, msg) to `out` and return 0; any non-zero return is treated as a
 * failure and no token is produced. */
typedef int (*hcs_hmac_sha256_fn)(void *ctx, const uint8_t *key, size_t key_len,
                                  const uint8_t *msg, size_t msg_len,
                                  uint8_t out[32]);

/* Writes a NUL-terminated, HCS_DEVICE_TOKEN_LEN-character token to `out`.
 * `out_cap` must be at least HCS_DEVICE_TOKEN_BUF_LEN.
 *
 * On any failure `out` is left as an empty string, so a caller that ignores
 * the return code sends no credential rather than a truncated one.
 *
 * Returns HCS_OK, HCS_ERR_ARG, HCS_ERR_CAPACITY or HCS_ERR_CRYPTO. */
hcs_err_t hcs_device_token_derive(char *out, size_t out_cap,
                                  const uint8_t psk[HCS_KEY_LEN],
                                  hcs_hmac_sha256_fn hmac, void *hmac_ctx);

#ifdef __cplusplus
}
#endif

#endif /* CSI_PROTOCOL_DEVICE_TOKEN_H */
