-- Adds a natural per-row dedup key for wire datagrams, so replaying a
-- capture range (via @homecsi/storage's replayCaptures) that was already
-- ingested — live, or by a previous replay of the same range — can use
-- INSERT ... ON CONFLICT DO NOTHING instead of silently double-inserting.
-- Replay is this project's core disaster-recovery / reprocessing loop
-- (docs/architecture.md "Data lifecycle"); flagged as a gap in the B3
-- report and fixed here, since B3 owns migrations 003+.
--
-- Identity keys, and why csi_records needs one more column than the wire
-- protocol's own tuple:
--
--   The wire protocol's datagram identity is (node_id, boot_epoch, seq)
--   (docs/protocol.md sections 3 and 6) — but that identifies one
--   DATAGRAM, and a single CSI_BATCH datagram carries `record_count`
--   individual CSI records (up to `max_records_per_batch`, default 16 —
--   docs/protocol.md section 11). csi_records is one row per *record*,
--   so it needs one more discriminator: `record_index`, the record's
--   0-based position within its batch (see
--   @homecsi/storage's DbWriteQueue.enqueueCsiBatch, which assigns it).
--   heartbeats is already one row per datagram, so (node_id, boot_epoch,
--   seq) alone is enough there.
--
-- Why `time` is part of both unique indexes even though it isn't part of
-- the wire-protocol identity tuple: TimescaleDB requires any unique
-- index/constraint on a hypertable to include the hypertable's
-- partitioning column. This does not weaken the dedup guarantee for the
-- actual use case (replaying the same capture bytes, or replaying over
-- already-ingested live data): `time` is *derived deterministically* from
-- each record's own fields (wall_clock_us/mono_us/rx_timestamp_us,
-- docs/protocol.md section 7 — see DbWriteQueue.enqueueCsiBatch), so
-- re-decoding the same wire bytes always reproduces the same `time`
-- value and therefore the same key.
--
-- Why every column below is added WITH `DEFAULT 0` that is then KEPT, rather
-- than being declared plainly NOT NULL:
--
--   Migration 003 enables TimescaleDB compression on csi_records and
--   heartbeats, and a compression-enabled hypertable accepts almost no
--   ALTER TABLE. Both of these were VERIFIED against a live
--   timescale/timescaledb:2.17.2-pg17, in this order, one deploy apart:
--
--     ALTER TABLE csi_records ADD COLUMN seq integer NOT NULL;
--     -> cannot add column with NOT NULL constraint without default
--        to a hypertable that has compression enabled
--
--     ALTER TABLE csi_records ALTER COLUMN seq DROP DEFAULT;
--     -> operation not supported on hypertables that have compression
--        enabled
--
--   So the documented workaround ("add it with a default, then drop the
--   default") only works halfway: the default can be added and cannot be
--   removed. It is therefore load-bearing, not scaffolding, and stays.
--
--   Note this restriction is about the table's compression SETTING, not its
--   contents — "the hypertables are still empty" does not buy an exemption.
--   The same applies to any future migration adding a column to
--   csi_records or heartbeats (003), ingest_metrics_snapshots (005), or
--   features (007) — every compressed hypertable in this schema. Migration
--   008 already does exactly this on `labels` (`NOT NULL DEFAULT 'manual'`),
--   for a different reason.
--
-- What the surviving default costs, and why it is acceptable: an INSERT
-- that omitted one of the dedup-key columns would write 0 instead of
-- failing. That does not silently corrupt the dedup key, because
-- idx_csi_records_datagram_identity below is UNIQUE — the first such row
-- inserts, and every subsequent one for the same node and timestamp is
-- rejected as a duplicate key. Loud on the second row rather than the
-- first. The writers (@homecsi/storage's DbWriteQueue) always list every
-- column explicitly, so this is a backstop, not a code path.

ALTER TABLE csi_records ADD COLUMN boot_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE csi_records ADD COLUMN seq integer NOT NULL DEFAULT 0;
ALTER TABLE csi_records ADD COLUMN record_index smallint NOT NULL DEFAULT 0;

-- sig_mode (docs/protocol.md section 9.2: 0 = non-HT/802.11b/g, 1 =
-- HT/802.11n) was omitted from migration 002. B4's feature extraction
-- needs it alongside rate/mcs to interpret a record's PHY mode
-- correctly — flagged in the B3 report and added here since it is a
-- cheap, additive column change on the same table this migration is
-- already altering.
ALTER TABLE csi_records ADD COLUMN sig_mode smallint NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX idx_csi_records_datagram_identity
  ON csi_records (node_id, boot_epoch, seq, record_index, time);

ALTER TABLE heartbeats ADD COLUMN boot_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE heartbeats ADD COLUMN seq integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX idx_heartbeats_datagram_identity
  ON heartbeats (node_id, boot_epoch, seq, time);
