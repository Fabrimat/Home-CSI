/*
 * net_uplink.h - drains the CSI ring, batches, seals, and sends UDP.
 *
 * Runs on its own task at its own priority so that nothing it does - DNS,
 * crypto, a blocked socket - can ever slow the CSI callback down. It only
 * touches the consumer side of the ring.
 *
 * Owns the single shared sequence counter (proto S3/S14): both CSI_BATCH and
 * HEARTBEAT datagrams are emitted from this task, so there is exactly one
 * place a seq can be allocated and no locking is needed for it.
 */
#ifndef HCS_NET_UPLINK_H
#define HCS_NET_UPLINK_H

#include <stdint.h>

#include "esp_err.h"

#include "node_config.h"

typedef struct {
    uint32_t batches_sent;
    uint32_t heartbeats_sent;
    uint32_t send_failures;
    uint32_t seal_failures;
    uint32_t resolve_failures;
    uint32_t records_too_large;
    uint32_t seq_exhausted;
} net_uplink_stats_t;

/* Starts the uplink task. boot_epoch comes from boot_epoch_begin(). */
esp_err_t net_uplink_start(const node_config_t *cfg, uint32_t boot_epoch);

void net_uplink_get_stats(net_uplink_stats_t *out);

/* True once at least one datagram has been accepted by the socket layer.
 * Used only to pick between the "connected, no server" and "streaming" LED
 * states - there are no acks in v1, so this is best-effort by definition. */
bool net_uplink_has_sent(void);

#endif /* HCS_NET_UPLINK_H */
