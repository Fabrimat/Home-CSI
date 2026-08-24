/*
 * ota.h - OTA auto-update client and the device HTTP surface.
 *
 * One low-priority task that does two things over HTTPS against the
 * `api_base` URL in NVS:
 *
 *   POST /device/hello          telemetry ping (version, boot epoch, uptime,
 *                               OTA state). Best effort; a failure here is a
 *                               logged warning and nothing else.
 *   GET  /device/ota/manifest   {version, sizeBytes, sha256}, or 204 for
 *                               "nothing for you".
 *   GET  /device/ota/firmware   the raw image.
 *
 * Both authenticate with `Authorization: Bearer <device_token>`, where the
 * token is derived from this node's existing per-node PSK by
 * components/csi_protocol/device_token.c. No new secret and no new
 * provisioning step: a board that can already seal a CSI datagram can
 * already talk to the device API.
 *
 * If `api_base` is absent from NVS, OTA is off: the node says so once and
 * carries on capturing. That is the state every board provisioned before this
 * feature existed is in, and it must not be a fault.
 */
#ifndef HCS_OTA_H
#define HCS_OTA_H

#include "esp_err.h"

#include "node_config.h"

/* Starts the OTA task. Safe (and useful) to call even when OTA is disabled:
 * the post-update health confirmation below has to happen regardless of
 * whether this node will ever fetch another image.
 *
 * Returns ESP_ERR_NO_MEM only if the task cannot be created. A missing or
 * unusable api_base is not an error. */
esp_err_t ota_start(const node_config_t *cfg);

/* The `otaState` string reported to /device/hello. Never NULL. */
const char *ota_state_str(void);

#endif /* HCS_OTA_H */
