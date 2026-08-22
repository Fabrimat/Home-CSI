/*
 * heartbeat.h - builds the 36-byte HEARTBEAT payload of docs/protocol.md S10.
 *
 * Heartbeats go out on a fixed interval independent of CSI activity, so the
 * server can tell "this node is alive but the house is still" apart from
 * "this node is dead". They are the only telemetry channel this system has:
 * every drop counter in the firmware funnels into frames_dropped here.
 */
#ifndef HCS_HEARTBEAT_H
#define HCS_HEARTBEAT_H

#include <stdint.h>

#include "csi_protocol/csi_wire.h"

/* Fills `out` from the live counters of csi_capture, net_uplink, wifi_link
 * and time_sync. batches_sent/send_failures are passed in because net_uplink
 * owns them. */
void heartbeat_build(hcs_heartbeat_t *out, uint32_t batches_sent,
                     uint32_t send_failures, uint32_t extra_dropped);

/* One-line human summary of everything in the heartbeat plus the per-reason
 * drop breakdown that does not fit in the 36-byte wire payload. Logged on
 * every heartbeat so a serial console is a complete diagnostic. */
void heartbeat_log(const hcs_heartbeat_t *hb);

#endif /* HCS_HEARTBEAT_H */
