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
-- Columns are added NOT NULL with no default: safe only because this is
-- a pre-launch, greenfield project (docs/architecture.md "Status") with
-- no rows in these hypertables yet in any real deployment. If either
-- table ever holds rows before a migration like this runs, it would need
-- a backfill step first (out of scope here).

ALTER TABLE csi_records ADD COLUMN boot_epoch integer NOT NULL;
ALTER TABLE csi_records ADD COLUMN seq integer NOT NULL;
ALTER TABLE csi_records ADD COLUMN record_index smallint NOT NULL;

-- sig_mode (docs/protocol.md section 9.2: 0 = non-HT/802.11b/g, 1 =
-- HT/802.11n) was omitted from migration 002. B4's feature extraction
-- needs it alongside rate/mcs to interpret a record's PHY mode
-- correctly — flagged in the B3 report and added here since it is a
-- cheap, additive column change on the same table this migration is
-- already altering.
ALTER TABLE csi_records ADD COLUMN sig_mode smallint NOT NULL;

CREATE UNIQUE INDEX idx_csi_records_datagram_identity
  ON csi_records (node_id, boot_epoch, seq, record_index, time);

ALTER TABLE heartbeats ADD COLUMN boot_epoch integer NOT NULL;
ALTER TABLE heartbeats ADD COLUMN seq integer NOT NULL;

CREATE UNIQUE INDEX idx_heartbeats_datagram_identity
  ON heartbeats (node_id, boot_epoch, seq, time);
