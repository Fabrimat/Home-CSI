/* boot_epoch.c - see boot_epoch.h. */

#include "boot_epoch.h"

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "csi_protocol/seq_epoch.h"

static const char *TAG = "boot_epoch";

/* Deliberately a DIFFERENT namespace from node_config's "homecsi".
 *
 * Provisioning rewrites the config namespace; the epoch is runtime state and
 * belongs with the node, not with the provisioning bundle. Keeping them apart
 * means a future "reprovision settings without resetting the epoch" flow is
 * possible. Note that erasing the whole nvs PARTITION still resets the epoch -
 * that is the documented, server-visible consequence in proto S6, and the
 * operator runbook must either assign a new node_id or clear the node's
 * replay state on the server. */
#define EPOCH_NAMESPACE "hcs_state"
#define EPOCH_KEY "boot_epoch"

static uint32_t s_epoch;

uint32_t boot_epoch_current(void)
{
    return s_epoch;
}

esp_err_t boot_epoch_begin(uint32_t *epoch_out)
{
    if (epoch_out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    *epoch_out = 0;

    nvs_handle_t h;
    esp_err_t err = nvs_open(EPOCH_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        /* Namespace creation only fails if NVS itself is broken. Report, and
         * let the caller decide - we must not invent an epoch silently. */
        ESP_LOGE(TAG, "nvs_open(%s) failed: %s", EPOCH_NAMESPACE,
                 esp_err_to_name(err));
        return err;
    }

    uint32_t stored = 0;
    err = nvs_get_u32(h, EPOCH_KEY, &stored);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGI(TAG, "no stored epoch - this is the first boot after "
                      "provisioning; starting at 1");
        stored = 0;
    } else if (err != ESP_OK) {
        /* Corrupt or unreadable entry. We cannot know how high the epoch got,
         * and guessing low would look like a rollback to the server. Refuse. */
        ESP_LOGE(TAG,
                 "stored epoch unreadable (%s). NOT guessing a value: an "
                 "epoch that goes backwards is rejected by the server as a "
                 "rollback (proto S6). Re-provision this node, or clear its "
                 "replay state server-side, before it can send again.",
                 esp_err_to_name(err));
        nvs_close(h);
        return ESP_ERR_INVALID_STATE;
    }

    uint32_t next = 0;
    if (hcs_boot_epoch_advance(stored, &next) != HCS_OK) {
        ESP_LOGE(TAG, "boot epoch space exhausted at %u - refusing to wrap",
                 (unsigned)stored);
        nvs_close(h);
        return ESP_ERR_INVALID_STATE;
    }

    /* Persist BEFORE returning, so that a crash one millisecond from now
     * cannot cause the same epoch to be reused on the next boot. */
    err = nvs_set_u32(h, EPOCH_KEY, next);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);

    s_epoch = next;
    *epoch_out = next;

    if (err != ESP_OK) {
        ESP_LOGE(TAG,
                 "failed to persist epoch %u (%s). Continuing would risk "
                 "reusing this epoch (and therefore an AEAD nonce) after the "
                 "next reboot.",
                 (unsigned)next, esp_err_to_name(err));
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "boot_epoch = %u (previous %u), one NVS write per boot",
             (unsigned)next, (unsigned)stored);
    return ESP_OK;
}
