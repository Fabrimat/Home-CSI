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
-- Why every column below is added WITH a default and then immediately has it
-- dropped, instead of being declared plainly NOT NULL:
--
--   Migration 003 enables TimescaleDB compression on csi_records and
--   heartbeats, and TimescaleDB refuses `ADD COLUMN ... NOT NULL` with no
--   default on a compression-enabled hypertable:
--
--     cannot add column with NOT NULL constraint without default
--     to a hypertable that has compression enabled
--
--   (It cannot fill the column in chunks that are already compressed. That
--   there are no such chunks yet does not matter — the check is on the
--   table's compression setting, not on its contents.) Adding the column
--   with a default and then dropping the default is TimescaleDB's own
--   documented workaround, and both steps are catalog-only here.
--
--   The default is dropped rather than kept because these are dedup-key
--   columns: leaving `DEFAULT 0` on seq/boot_epoch/record_index would let an
--   INSERT that forgot one of them silently write a wrong-but-valid identity
--   tuple instead of failing loudly. The default exists only for the width
--   of the ALTER.
--
--   This applies to any future migration adding a NOT NULL column to
--   csi_records or heartbeats (003), ingest_metrics_snapshots (005), or
--   features (007) — every compressed hypertable in this schema.
--
-- The end state is still NOT NULL with no default. That is safe only
-- because this is a pre-launch, greenfield project (docs/architecture.md
-- "Status") with no rows in these hypertables yet in any real deployment.
-- If either table ever holds rows before a migration like this runs, it
-- would need a backfill step first (out of scope here).

ALTER TABLE csi_records ADD COLUMN boot_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE csi_records ALTER COLUMN boot_epoch DROP DEFAULT;
ALTER TABLE csi_records ADD COLUMN seq integer NOT NULL DEFAULT 0;
ALTER TABLE csi_records ALTER COLUMN seq DROP DEFAULT;
ALTER TABLE csi_records ADD COLUMN record_index smallint NOT NULL DEFAULT 0;
ALTER TABLE csi_records ALTER COLUMN record_index DROP DEFAULT;

-- sig_mode (docs/protocol.md section 9.2: 0 = non-HT/802.11b/g, 1 =
-- HT/802.11n) was omitted from migration 002. B4's feature extraction
-- needs it alongside rate/mcs to interpret a record's PHY mode
-- correctly — flagged in the B3 report and added here since it is a
-- cheap, additive column change on the same table this migration is
-- already altering.
ALTER TABLE csi_records ADD COLUMN sig_mode smallint NOT NULL DEFAULT 0;
ALTER TABLE csi_records ALTER COLUMN sig_mode DROP DEFAULT;

CREATE UNIQUE INDEX idx_csi_records_datagram_identity
  ON csi_records (node_id, boot_epoch, seq, record_index, time);

ALTER TABLE heartbeats ADD COLUMN boot_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE heartbeats ALTER COLUMN boot_epoch DROP DEFAULT;
ALTER TABLE heartbeats ADD COLUMN seq integer NOT NULL DEFAULT 0;
ALTER TABLE heartbeats ALTER COLUMN seq DROP DEFAULT;

CREATE UNIQUE INDEX idx_heartbeats_datagram_identity
  ON heartbeats (node_id, boot_epoch, seq, time);
