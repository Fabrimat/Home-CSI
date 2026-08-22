-- Core schema for Home CSI.
--
-- NOTE: this migration intentionally does NOT add any retention or
-- compression policy (timescaledb_information.compression_settings /
-- add_retention_policy / add_compression_policy). Those are brief B3's
-- responsibility (packages/storage) and belong in migration 003+, once the
-- lifecycle rules in docs/architecture.md ("Data lifecycle") are
-- implemented against real ingest volume.

-- ---------------------------------------------------------------------
-- nodes: the node registry. Small, low-churn, not a hypertable. Mirrors
-- (but does not replace) the `nodes` section of packages/config — this
-- table is what foreign keys below point at and what heartbeats/CSI
-- records are attributed to.
-- ---------------------------------------------------------------------
CREATE TABLE nodes (
  id integer PRIMARY KEY,
  name text NOT NULL,
  room text NOT NULL,
  expected_mac macaddr,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- csi_records: the highest-volume table in the system — one row per CSI
-- record per node (docs/protocol.md section 9.2). Raw csi_data is stored
-- as bytea and MUST be parsed by consumers using csi_format + its own
-- length, never assumed fixed (docs/architecture.md "Amplitude-first").
--
-- Chunk interval: 1 hour. With up to 9 nodes each capturing CSI from
-- broadcast soundings across the whole mesh (docs/architecture.md, the
-- "broadcast-sounding mesh" link-count arithmetic), per-node capture rate
-- can be high; hourly chunks keep individual chunk size manageable for
-- both query planning and the compression/retention policies B3 will add,
-- without creating an excessive number of tiny chunks during quiet
-- periods.
-- ---------------------------------------------------------------------
CREATE TABLE csi_records (
  time timestamptz NOT NULL,
  node_id integer NOT NULL REFERENCES nodes(id),
  src_mac macaddr NOT NULL,
  dst_mac macaddr NOT NULL,
  rssi smallint NOT NULL,
  rate smallint NOT NULL,
  mcs smallint NOT NULL,
  bandwidth smallint NOT NULL,
  channel smallint NOT NULL,
  secondary_channel smallint NOT NULL,
  noise_floor smallint NOT NULL,
  csi_format smallint NOT NULL,
  csi_data bytea NOT NULL
);

SELECT create_hypertable('csi_records', 'time', chunk_time_interval => INTERVAL '1 hour');

-- Supports "recent records for this node" queries, which the features
-- pipeline (brief B4) runs continuously per node/link.
CREATE INDEX idx_csi_records_node_time ON csi_records (node_id, time DESC);
-- Supports link-level queries (a specific node-to-node or node-to-AP link)
-- used both by feature extraction and by the 2+ occupancy stretch goal's
-- cross-link simultaneity analysis (docs/architecture.md).
CREATE INDEX idx_csi_records_src_mac_time ON csi_records (src_mac, time DESC);

-- ---------------------------------------------------------------------
-- heartbeats: one row per HEARTBEAT datagram (docs/protocol.md section
-- 10). Low volume relative to csi_records, so a coarser daily chunk
-- interval keeps the chunk count reasonable.
-- ---------------------------------------------------------------------
CREATE TABLE heartbeats (
  time timestamptz NOT NULL,
  node_id integer NOT NULL REFERENCES nodes(id),
  uptime_s integer NOT NULL,
  free_heap_bytes integer NOT NULL,
  min_free_heap_bytes integer NOT NULL,
  frames_captured integer NOT NULL,
  frames_dropped integer NOT NULL,
  batches_sent integer NOT NULL,
  send_failures integer NOT NULL,
  rssi_to_ap smallint NOT NULL,
  channel smallint NOT NULL,
  sntp_synced boolean NOT NULL,
  fw_version text NOT NULL
);

SELECT create_hypertable('heartbeats', 'time', chunk_time_interval => INTERVAL '1 day');

CREATE INDEX idx_heartbeats_node_time ON heartbeats (node_id, time DESC);

-- ---------------------------------------------------------------------
-- features: windowed amplitude feature vectors computed by brief B4 from
-- csi_records. The feature set itself is B4's to define and will evolve,
-- so the vector is stored as jsonb rather than as fixed columns —
-- avoiding a migration every time a feature is added or removed, while
-- `window_ms` and `link_mac` stay as real columns since every consumer
-- (including occupancy, brief B4) needs to filter/join on them.
-- ---------------------------------------------------------------------
CREATE TABLE features (
  time timestamptz NOT NULL,
  node_id integer NOT NULL REFERENCES nodes(id),
  link_mac macaddr,
  window_ms integer NOT NULL,
  feature_vector jsonb NOT NULL
);

SELECT create_hypertable('features', 'time', chunk_time_interval => INTERVAL '1 day');

CREATE INDEX idx_features_node_time ON features (node_id, time DESC);

-- ---------------------------------------------------------------------
-- occupancy_states: the output of the latched occupancy state machine
-- (docs/architecture.md "Motion, not people"). This is a whole-house
-- estimate, not per-node, so there is no node_id here.
-- ---------------------------------------------------------------------
CREATE TABLE occupancy_states (
  time timestamptz NOT NULL,
  -- 0, 1, or 2 (meaning "2+"), per the v1/stretch success criteria.
  estimate smallint NOT NULL,
  confidence real NOT NULL,
  -- The state machine's own state label (e.g. "unoccupied", "occupied",
  -- "decaying") — free text so brief B4 can evolve the state set without
  -- a migration.
  state text NOT NULL,
  details jsonb
);

SELECT create_hypertable('occupancy_states', 'time', chunk_time_interval => INTERVAL '1 day');

-- ---------------------------------------------------------------------
-- label_sessions / labels: manually-entered ground truth for supervised
-- evaluation and eventual model training (docs/roadmap.md "Trained-model
-- inference"). Low volume, human-entered — plain relational tables, not
-- hypertables.
-- ---------------------------------------------------------------------
CREATE TABLE label_sessions (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  notes text
);

CREATE TABLE labels (
  id bigserial PRIMARY KEY,
  session_id bigint NOT NULL REFERENCES label_sessions(id) ON DELETE CASCADE,
  time timestamptz NOT NULL,
  -- Ground truth occupancy count at `time` (0, 1, 2, ... — exact if known,
  -- otherwise the same 0/1/2+ scale as occupancy_states.estimate).
  occupancy_count smallint NOT NULL,
  notes text
);

CREATE INDEX idx_labels_session_time ON labels (session_id, time);
CREATE INDEX idx_labels_time ON labels (time);
