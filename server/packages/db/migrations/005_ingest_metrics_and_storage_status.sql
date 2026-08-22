-- Durable, cross-process ingest observability for brief B5's debug UI
-- (packages/api "Overview" panel). @homecsi/ingest's in-process
-- `getIngestMetrics()` export cannot be read from a separate process:
-- `ingest` and `serve` are separate CLI commands and separate containers
-- (ops/docker-compose.yml). Instead, `runIngest` periodically snapshots
-- its counters and the raw-capture disk budget here (see
-- @homecsi/storage's `writeMetricsSnapshot` / `writeStorageStatus` /
-- `computeStorageStatus`). The in-process export is kept as well, for a
-- same-process caller or future use.
--
-- ---------------------------------------------------------------------
-- ingest_metrics_snapshots: one row per (time, reason) per snapshot
-- tick. `count` is the *cumulative* counter value at that time (matching
-- how ingest's own in-process counters behave, and how Prometheus-style
-- counters are conventionally stored) -- a consumer wanting a rate over
-- an interval diffs two snapshots, it is not a delta already.
--
-- `reason` names every counter @homecsi/ingest exposes via
-- IngestMetrics: 'accepted', 'datagrams_received', 'bytes_received',
-- 'records_written', 'batch_insert_failures', 'queue_depth',
-- 'queue_drops', 'capture_write_failures', and 'rejected.<reason>' for
-- each distinct rejection reason (e.g. 'rejected.auth_failed' for a bad
-- AEAD tag, 'rejected.stale_epoch' / 'rejected.too_old' /
-- 'rejected.duplicate' for replay-window rejects,
-- 'rejected.malformed_payload', 'rejected.unknown_node', etc. -- see
-- @homecsi/ingest's RejectReason union for the full list).
--
-- Segmented/ordered/compressed/retained the same way as csi_records
-- (migration 003) and for the same reason (recent-rows-for-one-key, in
-- time order) -- here the "key" is `reason` rather than `node_id`.
-- ---------------------------------------------------------------------
CREATE TABLE ingest_metrics_snapshots (
  time timestamptz NOT NULL,
  reason text NOT NULL,
  count bigint NOT NULL
);

SELECT create_hypertable('ingest_metrics_snapshots', 'time', chunk_time_interval => INTERVAL '1 day');

CREATE INDEX idx_ingest_metrics_snapshots_reason_time
  ON ingest_metrics_snapshots (reason, time DESC);

DO $policy$
BEGIN
  EXECUTE $sql$
    ALTER TABLE ingest_metrics_snapshots SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'reason',
      timescaledb.compress_orderby = 'time DESC'
    )
  $sql$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not enable TimescaleDB compression on ingest_metrics_snapshots.
This requires a TimescaleDB build with Community features enabled -- see
https://docs.timescale.com/about/latest/timescaledb-editions/.
Original error: %', SQLERRM;
END
$policy$;

DO $policy$
BEGIN
  PERFORM add_compression_policy('ingest_metrics_snapshots', INTERVAL '3 days');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a compression policy on ingest_metrics_snapshots
(add_compression_policy). This requires TimescaleDB Community features and
the background job scheduler to be enabled. Original error: %', SQLERRM;
END
$policy$;

-- Short retention: this is a live/recent-health signal for an operator
-- debug UI, not a long-term dataset like csi_records.
DO $policy$
BEGIN
  PERFORM add_retention_policy('ingest_metrics_snapshots', INTERVAL '30 days');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a retention policy on ingest_metrics_snapshots
(add_retention_policy). Original error: %', SQLERRM;
END
$policy$;

-- ---------------------------------------------------------------------
-- storage_status: one row per snapshot tick describing the raw-capture
-- disk budget (config.storage.captureDir usage vs.
-- config.storage.retention.maxTotalBytes) -- the same two numbers
-- packages/cli's `doctor` command prints, made durable/queryable so
-- B5's debug UI can show disk pressure without shelling out to `doctor`
-- or reading the filesystem itself.
--
-- Extremely low volume (one row per snapshot tick, e.g. ~1440/day at a
-- 1-minute interval) -- not worth a compression policy, but still gets a
-- retention policy so it does not accumulate forever.
-- ---------------------------------------------------------------------
CREATE TABLE storage_status (
  time timestamptz NOT NULL,
  bytes_used bigint NOT NULL,
  bytes_budget bigint NOT NULL
);

SELECT create_hypertable('storage_status', 'time', chunk_time_interval => INTERVAL '7 days');

DO $policy$
BEGIN
  PERFORM add_retention_policy('storage_status', INTERVAL '30 days');
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add a retention policy on storage_status
(add_retention_policy). Original error: %', SQLERRM;
END
$policy$;
