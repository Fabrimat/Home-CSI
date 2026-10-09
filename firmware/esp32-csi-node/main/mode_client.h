/*
 * mode_client.h - burst/realtime mode client.
 *
 * One low-priority task that polls `GET /device/mode` (docs/device-api.md,
 * brief B1) over HTTPS against the `api_base` URL in NVS - the same device
 * HTTP realm, the same bearer-token derivation
 * (components/csi_protocol/device_token.c) and the same "never fatal, never
 * part of any rollback health checkpoint" failure register as main/ota.c's
 * hello. A failure to reach the server here is a logged warning and nothing
 * else: capture and uplink are completely unaffected, and this node simply
 * stays on whatever mode it last applied (with its own local deadline still
 * ticking - see below).
 *
 * The server can ask this node to run temporarily "hot": faster sounding,
 * tighter batching, for a recording experiment. Two properties make that
 * safe to accept from a server this node does not otherwise trust with a
 * command channel - both implemented in the pure, host-tested
 * components/csi_protocol/mode_policy.c, not here:
 *
 *   1. Every knob the server proposes is clamped to an independent Kconfig
 *      ceiling ("Realtime (burst) mode" in menuconfig) before it is ever
 *      applied. A value beyond a ceiling is clamped to it and logged, never
 *      applied verbatim and never rejected outright.
 *
 *   2. A realtime directive's `expiresAt` is converted to this node's own
 *      esp_timer clock exactly once, at the moment it is applied, and the
 *      duration used is itself clamped to HCS_REALTIME_MAX_DURATION_S
 *      regardless of what the wall clock or the server claims. Reversion to
 *      normal mode on that local deadline is unconditional - it happens
 *      whether or not the server ever answers another poll, which is what
 *      makes it impossible for a wedged experiment (or a server that has
 *      simply gone away) to leave the mesh running hot indefinitely.
 *
 * If `api_base` is absent from NVS, this client is disabled: the node says
 * so once and carries on capturing at whatever mode it was already in
 * (normal, always, since nothing can have set it otherwise). Same posture
 * as OTA being off - not a fault.
 */
#ifndef HCS_MODE_CLIENT_H
#define HCS_MODE_CLIENT_H

#include "esp_err.h"

#include "node_config.h"

/* Starts the mode-poll task. `cfg` is captured as this node's NORMAL
 * baseline (sounding interval, bandwidth budget, batch knobs) - the exact
 * values reverted to on an explicit "normal" directive or on local deadline
 * expiry. Safe to call even when the device API is disabled (no api_base):
 * logs once and does not start a task.
 *
 * Returns ESP_ERR_NO_MEM only if the task cannot be created. A missing or
 * unusable api_base is not an error. */
esp_err_t mode_client_start(const node_config_t *cfg);

#endif /* HCS_MODE_CLIENT_H */
