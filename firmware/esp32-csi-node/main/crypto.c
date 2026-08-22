/* crypto.c - see crypto.h. */

#include "crypto.h"

#include <string.h>

#include "esp_log.h"

static const char *TAG = "crypto";

esp_err_t hcs_crypto_init(hcs_crypto_t *c, const uint8_t psk[HCS_KEY_LEN])
{
    if (c == NULL || psk == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    mbedtls_chachapoly_init(&c->ctx);
    const int rc = mbedtls_chachapoly_setkey(&c->ctx, psk);
    if (rc != 0) {
        ESP_LOGE(TAG, "mbedtls_chachapoly_setkey failed: -0x%04x", -rc);
        mbedtls_chachapoly_free(&c->ctx);
        c->ready = false;
        return ESP_FAIL;
    }
    c->ready = true;
    ESP_LOGI(TAG, "ChaCha20-Poly1305 ready (mbedTLS)");
    return ESP_OK;
}

void hcs_crypto_deinit(hcs_crypto_t *c)
{
    if (c == NULL) {
        return;
    }
    /* mbedtls_chachapoly_free zeroises the internal key schedule. */
    mbedtls_chachapoly_free(&c->ctx);
    c->ready = false;
}

int hcs_crypto_seal(void *ctx, const uint8_t key[HCS_KEY_LEN],
                    const uint8_t nonce[HCS_NONCE_LEN], const uint8_t *aad,
                    size_t aad_len, const uint8_t *pt, size_t pt_len,
                    uint8_t *ct_out, uint8_t tag_out[HCS_TAG_LEN])
{
    (void)key; /* bound at init; see the header */
    hcs_crypto_t *c = (hcs_crypto_t *)ctx;
    if (c == NULL || !c->ready) {
        return -1;
    }

    /* mbedtls_chachapoly_encrypt_and_tag is the one-shot IETF construction:
     * 96-bit nonce, AAD, 128-bit tag - exactly proto S5. */
    const int rc = mbedtls_chachapoly_encrypt_and_tag(
        &c->ctx, pt_len, nonce, aad, aad_len, pt, ct_out, tag_out);
    if (rc != 0) {
        ESP_LOGE(TAG, "chachapoly_encrypt_and_tag: -0x%04x", -rc);
        return -1;
    }
    return 0;
}
