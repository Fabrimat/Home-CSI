/*
 * boot_epoch.h - the persisted boot counter required by docs/protocol.md S6.
 *
 * Why it exists: seq restarts at 0 on every power cycle, and these nodes will
 * lose power (breakers, reflashes, unplugged USB supplies). Without an epoch,
 * a replayed datagram from a previous boot is indistinguishable from a fresh
 * one. boot_epoch makes the identity tuple (node_id, boot_epoch, seq)
 * globally unique for the life of a provisioning, which is also what keeps
 * the AEAD nonce unique.
 *
 * FLASH WEAR: exactly ONE u32 NVS write per boot, done once during startup
 * and never again while running. NVS is wear-levelled across the 24 kB nvs
 * partition and each page holds ~126 entries before compaction, so even a
 * pessimistic reading of the ESP32 flash endurance (100k erase cycles per
 * sector) puts this in the millions-of-boots range. It is not a concern; a
 * per-datagram or per-minute write would have been.
 */
#ifndef HCS_BOOT_EPOCH_H
#define HCS_BOOT_EPOCH_H

#include <stdint.h>

#include "esp_err.h"

/* Reads the stored epoch, increments it, persists the new value, and returns
 * it. Must be called exactly once, early in startup, BEFORE any datagram is
 * sent - the new value is committed first so that a crash immediately after
 * boot can never re-use an epoch.
 *
 * First-ever boot (key absent) yields epoch 1.
 *
 * Returns ESP_ERR_INVALID_STATE if the epoch space is exhausted (2^32 boots);
 * wrapping is refused because the server treats a decreasing epoch as a
 * rollback attack (proto S6 step 2) and would blackhole the node.
 *
 * If the value cannot be persisted, *epoch_out is still set to a usable
 * value and ESP_FAIL is returned: the caller decides whether to run anyway.
 * Running with an unpersisted epoch risks a duplicate epoch after the next
 * reboot, so main.c treats it as a fatal, loudly-reported condition. */
esp_err_t boot_epoch_begin(uint32_t *epoch_out);

/* The value chosen by boot_epoch_begin(), or 0 before it has run. */
uint32_t boot_epoch_current(void);

#endif /* HCS_BOOT_EPOCH_H */
