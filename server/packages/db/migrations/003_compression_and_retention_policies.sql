-- TimescaleDB compression + retention policies for the highest-volume
-- hypertables (csi_records, heartbeats). Owned by brief B3
-- (packages/ingest, packages/storage) per docs/architecture.md "Data
-- lifecycle" -- migration 002 deliberately left these out.
--
-- IMPORTANT -- two distinct, independent budgets, do not confuse them:
--   * This migration governs the *database* (TimescaleDB hypertable
--     rows): when a chunk gets compressed, and when `drop_chunks` deletes
--     rows entirely from Postgres.
--   * `config.storage.retention` (packages/config, enforced by
--     `@homecsi/storage`'s `pruneStorage`) governs the *raw capture
--     files* on disk under `storage.captureDir` -- a completely separate
--     on-disk replay log with its own independent age/size budget.
--     Dropping a DB chunk here does NOT delete the corresponding raw
--     capture file, and vice versa; an operator who wants to reprocess
--     data after a DB retention drop can still do so via `homecsi
--     replay`, as long as the raw capture files are still within
--     *their own* retention window.
--
-- Compression segmentby/orderby are deliberate, not defaults: the
-- dominant query pattern across this system (features extraction, B4;
-- debug UI, B5) is "recent rows for one node/link, in time order" (see
-- the existing idx_csi_records_node_time / idx_heartbeats_node_time
-- indexes from migration 002). Segmenting by node_id keeps each node's
-- rows in their own compressed segment, so a per-node query only has to
-- decompress that node's segments, not the whole chunk; ordering by
-- time DESC within a segment matches "most recent N for this node"
-- access and gives the compression algorithm long runs of
-- similarly-ordered values to work with (better compression ratio than
-- an unordered layout would achieve).
--
-- Indexes: 002's existing idx_csi_records_node_time,
-- idx_csi_records_src_mac_time, and idx_heartbeats_node_time already
-- cover every access pattern ingest's own write path needs (ingest only
-- ever INSERTs; it does not query these tables). No additional index is
-- added here for that reason -- further read-pattern-driven indexes are
-- for the consuming briefs (B4/B5) to add against their own real query
-- shapes.
--
-- Chosen ages below are documented assumptions, not hard requirements --
-- an operator can freely change either policy later, e.g.:
--   SELECT remove_compression_policy('csi_records');
--   SELECT add_compression_policy('csi_records', INTERVAL '2 days');
--   SELECT remove_retention_policy('csi_records');
--   SELECT add_retention_policy('csi_records', INTERVAL '60 days');
-- (same pattern for heartbeats)
--
--   * csi_records: compress after 1 day (a short "hot" window during
--     which rows are still being actively written/queried uncompressed
--     by the live features pipeline), retain (drop_chunks) after 90
--     days -- long enough to cover several months-old-bug
--     investigations without keeping the highest-volume table's rows
--     around indefinitely.
--   * heartbeats: much lower volume (one row per node per heartbeat
--     interval, not per CSI frame); compress after 3 days, retain for
--     180 days -- cheap to keep longer and useful for node-health
--     history / debugging flaky nodes over time.
--
-- TimescaleDB's compression storage option (`timescaledb.compress`) and
-- its policy-scheduler functions (add_compression_policy,
-- add_retention_policy) are part of the "Community" feature set of the
-- timescaledb extension, not the Apache-2-only build. If the installed
-- extension build lacks Community features (or the background job
-- scheduler is unavailable), the statements below fail with a raw
-- Postgres error (e.g. an undefined-function or license error); each is
-- wrapped in its own DO block below to catch that and re-raise a clear,
-- actionable message instead of leaving an operator to decode it.

DO $policy$
BEGIN
  EXECUTE $sql$
    ALTER TABLE csi_records SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'node_id',
      timescaledb.compress_orderby = 'time DESC'
    )
  $sql$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not enable TimescaleDB compression on csi_records.
This requires a TimescaleDB build with Community features enabled
(compression is not available in the Apache-2-only edition) -- see
https://docs.timescale.com/about/latest/timescaledb-editions/.
Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  PERFORM add_compression_policy('csi_records', INTERVAL '1 day');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a compression policy on csi_records
(add_compression_policy). This requires TimescaleDB Community features
and the background job scheduler to be enabled. Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  PERFORM add_retention_policy('csi_records', INTERVAL '90 days');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a retention policy on csi_records
(add_retention_policy). This requires TimescaleDB Community features and
the background job scheduler to be enabled. Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  EXECUTE $sql$
    ALTER TABLE heartbeats SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'node_id',
      timescaledb.compress_orderby = 'time DESC'
    )
  $sql$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not enable TimescaleDB compression on heartbeats.
Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  PERFORM add_compression_policy('heartbeats', INTERVAL '3 days');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a compression policy on heartbeats
(add_compression_policy). Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  PERFORM add_retention_policy('heartbeats', INTERVAL '180 days');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a retention policy on heartbeats
(add_retention_policy). Original error: %', SQLERRM;
END
$policy$;
