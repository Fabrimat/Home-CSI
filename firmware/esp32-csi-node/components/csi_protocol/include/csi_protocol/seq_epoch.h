/*
 * seq_epoch.h - the datagram identity counter
 * (docs/protocol.md S3, S4, S4.1, S6).
 *
 * The replay identity of a datagram is (node_id, boot_epoch, seq) and the
 * AEAD nonce is a pure function of that tuple. So nonce uniqueness under one
 * per-node key is guaranteed *structurally* by two invariants owned here:
 *
 *   1. seq starts at 0 on the first datagram after boot, increases by
 *      exactly 1 per datagram (batch or heartbeat - ONE shared counter), and
 *      NEVER wraps. Reaching 2^32-1 is a hard stop: the node stops sending
 *      and requests a reboot rather than reusing a nonce.
 *   2. boot_epoch strictly increases across reboots. Wrapping it would look
 *      identical to a rollback attack to the server (S6 step 2) and would
 *      blackhole the node permanently, so that is refused too: the stored
 *      value is left PINNED at 0xFFFFFFFF rather than wrapping.
 *
 * Both hard stops are normative in docs/protocol.md S4.1.
 *
 * At the design rate (a few tens of datagrams per second) 2^32 sequence
 * numbers is multiple years of continuous uptime, and 2^32 boots is
 * unreachable; both limits exist so the failure mode is "stop and shout"
 * instead of "silently reuse a nonce".
 *
 * Host-compilable; the NVS persistence half lives in main/boot_epoch.c.
 */
#ifndef CSI_PROTOCOL_SEQ_EPOCH_H
#define CSI_PROTOCOL_SEQ_EPOCH_H

#include <stdbool.h>
#include <stdint.h>

#include "csi_protocol/csi_wire.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint16_t node_id;
    uint32_t boot_epoch;
    uint32_t next_seq;
    bool exhausted;
} hcs_seq_t;

/* node_id 0 is reserved/invalid (proto S3) and is rejected here so a
 * misprovisioned node fails loudly at boot instead of emitting datagrams the
 * server will throw away. */
hcs_err_t hcs_seq_init(hcs_seq_t *s, uint16_t node_id, uint32_t boot_epoch);

/* Allocate the next sequence number and fill a ready-to-encode header.
 * Returns HCS_ERR_EXHAUSTED once the sequence space is used up. */
hcs_err_t hcs_seq_next(hcs_seq_t *s, uint8_t msg_type, hcs_header_t *out);

bool hcs_seq_exhausted(const hcs_seq_t *s);

/* Compute the boot_epoch for this boot from the persisted previous value.
 * Returns HCS_ERR_EXHAUSTED (and leaves *next at the input) rather than
 * wrapping to 0. */
hcs_err_t hcs_boot_epoch_advance(uint32_t stored, uint32_t *next);

#ifdef __cplusplus
}
#endif

#endif /* CSI_PROTOCOL_SEQ_EPOCH_H */
