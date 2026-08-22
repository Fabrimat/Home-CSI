-- Right-sizes data retention to what the user actually wants (brief B8,
-- docs/architecture.md "Data lifecycle"): raw data kept only for a short
-- *debug window*, the occupancy event log kept *forever*, and the training
-- set for future model retraining preserved deliberately rather than by
-- accident.
--
-- Three measured facts drove this migration:
--   * `features` and `occupancy_states` got NO compression/retention policy
--     in migration 003 (it only covered csi_records/heartbeats). At 9 nodes
--     `features` is ~144 rows/s ~= 4.2 GB/day, unbounded -- this fills the
--     disk before anything else does.
--   * `csi_records` retention was 90 days (432 GB at 9 nodes) while the
--     on-disk capture tree (`config.storage.retention`) was already tighter
--     at 30 days / 100 GiB -- the two were inconsistent with each other and
--     both looser than needed.
--   * The agreed debug window, everywhere, is 7 days.
--
-- ---------------------------------------------------------------------
-- csi_records: retighten retention from 90 days to 7 days.
--
-- Compression (1 day, migration 003) is untouched -- only the drop_chunks
-- age changes. `if_exists => true` on the removal makes this migration
-- safe to reason about even if a future operator has already hand-tuned
-- the policy away (see migration 003's own comment showing
-- remove_retention_policy/add_retention_policy as the supported way to
-- change these later).
-- ---------------------------------------------------------------------
DO $policy$
BEGIN
  PERFORM remove_retention_policy('csi_records', if_exists => true);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not remove the existing retention policy on
csi_records (remove_retention_policy) before retightening it to 7 days.
This requires TimescaleDB Community features and the background job
scheduler to be enabled -- see
https://docs.timescale.com/about/latest/timescaledb-editions/.
Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  PERFORM add_retention_policy('csi_records', INTERVAL '7 days');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add the retightened 7-day retention policy on
csi_records (add_retention_policy). Original error: %', SQLERRM;
END
$policy$;

-- ---------------------------------------------------------------------
-- features: compression + 7-day retention -- the table migration 003
-- should have covered but didn't. Same segmentby/orderby rationale as
-- csi_records/heartbeats (migration 003): the dominant query pattern is
-- "recent windows for one node/link, in time order", so segmenting by
-- node_id keeps a per-node query's decompression work scoped to that
-- node's own segments.
--
-- Compress after 1 day (short hot window -- the live occupancy pipeline,
-- brief B4, reads recent uncompressed rows continuously), retain
-- (drop_chunks) after 7 days -- the agreed debug window. Rows inside
-- labelled windows that need to survive past 7 days are copied out to the
-- plain `training_features` table below *before* they age out; this
-- policy itself stays a clean, unmodified, declarative TimescaleDB policy
-- (see the "training_features" section for why a policy is kept instead
-- of a hand-rolled row-level deletion job).
-- ---------------------------------------------------------------------
DO $policy$
BEGIN
  EXECUTE $sql$
    ALTER TABLE features SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'node_id',
      timescaledb.compress_orderby = 'time DESC'
    )
  $sql$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not enable TimescaleDB compression on features.
This requires a TimescaleDB build with Community features enabled -- see
https://docs.timescale.com/about/latest/timescaledb-editions/.
Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  PERFORM add_compression_policy('features', INTERVAL '1 day');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a compression policy on features
(add_compression_policy). This requires TimescaleDB Community features and
the background job scheduler to be enabled. Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  PERFORM add_retention_policy('features', INTERVAL '7 days');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a retention policy on features
(add_retention_policy). Original error: %', SQLERRM;
END
$policy$;

-- ---------------------------------------------------------------------
-- occupancy_states: deliberately NO retention policy, and NO compression.
-- This is the forever occupancy event log the user cares about -- once
-- the sparse rewrite lands (transitions + a 15-minute keepalive instead of
-- 2 rows/s, a sibling brief's concern, not this migration's), the whole
-- table is projected at roughly 3 MB/year. At that volume:
--   * A retention policy would throw away the one thing this project is
--     actually meant to answer later ("was the house occupied on date X"),
--     for a disk saving that rounds to zero. Not added, on purpose.
--   * Compression saves nothing measurable at ~3 MB/year, but *does* add
--     TimescaleDB Community-features dependency and compressed-chunk
--     semantics (decompress-to-update, chunk-level compression status,
--     etc.) to the one table that must stay trivially queryable and
--     backfillable forever (e.g. a future manual correction of a
--     mis-latched period, or the sparse-rewrite sibling brief backfilling
--     history). Also not added, on purpose -- an operator who later
--     decides the tradeoff is worth it can add it the same way migration
--     003 added it to csi_records/heartbeats.
--
-- This migration does NOT assume `occupancy_states` is already sparse --
-- the sparse rewrite (transitions + keepalive instead of dense 2 rows/s)
-- is a concurrent, separate change to the *writer* (brief-owned migration
-- 006 territory), not to this table's schema, which is unchanged here.
--
-- Pre-existing dense rows (2/s, from any environment that ran the dense
-- writer before the sparse rewrite ships) are LEFT AS-IS by this
-- migration -- not truncated, not compacted into synthetic transitions.
-- Reasoning:
--   * This project is pre-launch/greenfield (docs/architecture.md
--     "Status") -- there is no real-world deployment with months of dense
--     history to worry about; any dense rows that exist anywhere this
--     migration runs are dev/staging data, bounded in size by definition
--     (the project hasn't been running long enough for "2 rows/s forever"
--     to have actually cost anything yet).
--   * A one-time SQL compaction (e.g. a LAG()-based "keep only rows where
--     state changed, plus a synthetic keepalive") is exactly the kind of
--     row-level surgery this migration otherwise argues against doing to
--     `features` -- it's non-trivial to get right (what counts as "the
--     same state" across `estimate`/`confidence`/`state`/`details`?), hard
--     to test, irreversible, and buys nothing but disk savings this table
--     doesn't need. A destructive, hard-to-verify migration step is a
--     worse trade than a bounded amount of old dense rows sitting
--     unindexed-against in a forever-log.
--   * If an operator on a specific deployment wants retroactive
--     compaction anyway, that is a deliberate, reviewable, one-off
--     operation to run by hand against that deployment's own data, not a
--     blanket destructive step baked into a forward-only migration that
--     every environment (including brand new ones with zero rows) runs.
--
-- No SQL statements needed for this table -- this section is
-- documentation of the decision made, not a policy to add.

-- ---------------------------------------------------------------------
-- training_features: preserved raw per-link feature rows for MANUAL
-- label-session windows, copied out of `features` before the 7-day
-- retention policy above drops them (brief B8, @homecsi/labeling).
--
-- Why "copy out, don't hand-roll deletion": TimescaleDB's
-- `add_retention_policy` uses `drop_chunks`, which is chunk-granular and
-- cannot exempt individual rows. A custom row-wise deletion job that tried
-- to keep labelled rows in-place in `features` would need DELETE against
-- (eventually compressed) chunks -- painful-to-unsupported depending on
-- TimescaleDB version, defeats compression, bloats with tombstones, and
-- replaces a declarative policy with a job that must never miss a run.
-- Copying the rows worth keeping into a separate plain table, before the
-- native retention policy runs, keeps `add_retention_policy('features',
-- '7 days')` clean and native, and makes the "what needs to survive"
-- question app-level logic (@homecsi/labeling), not database policy.
--
-- Plain table, not a hypertable: preserved volume is bounded by how much
-- manual labelling an operator actually does, not by raw ingest rate --
-- no partitioning benefit at this scale.
--
-- PK (time, node_id, link_mac) matches the natural per-(node,link,window)
-- identity of a `features` row and makes preservation idempotent: the
-- session-close hook and the CLI sweep backstop (@homecsi/labeling) can
-- both attempt to preserve the same window and rely on
-- `ON CONFLICT (time, node_id, link_mac) DO NOTHING` rather than tracking
-- "have I already copied this" themselves.
--
-- Deliberately NOT populated for weak (phone-presence) labels -- see
-- @homecsi/labeling's preservation logic for why (an always-on presence
-- probe cron would otherwise make "labelled" cover practically all of
-- `features`, defeating the retention policy above entirely).
-- ---------------------------------------------------------------------
CREATE TABLE training_features (
  time timestamptz NOT NULL,
  node_id integer NOT NULL REFERENCES nodes(id),
  link_mac macaddr NOT NULL,
  window_ms integer NOT NULL,
  feature_vector jsonb NOT NULL,
  preserved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (time, node_id, link_mac)
);

-- Supports `homecsi train` reading a time range out of training_features
-- the same way it already reads `features` (packages/labeling).
CREATE INDEX idx_training_features_time ON training_features (time);
