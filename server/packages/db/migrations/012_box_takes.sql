-- Preserves raw CSI for the "hand in a closed box" recreational gesture
-- experiment (brief B3, docs/box-experiment.md). Depends on migration 011
-- (brief B1): `nodes.role` ('house'|'box') and `box_sessions` (one row per
-- TAKE -- one hold-to-record of one gesture, id/started_at/ended_at/
-- gesture_class/geometry_note/notes).
--
-- ---------------------------------------------------------------------
-- box_take_records: the box-experiment counterpart to `training_features`
-- (migration 007) -- copied out of `csi_records` before migration 007's
-- 7-day retention policy drops it, so a take stays trainable long after its
-- raw `csi_records` rows have aged out.
--
-- PERSISTS RAW CSI, NOT COMPUTED FEATURES -- deliberately, unlike
-- `training_features` (which stores an already-computed `feature_vector`).
-- Feature iteration is the entire point of a recreational ML experiment:
-- freezing to one feature set at capture time would make every past take
-- unusable the instant the operator wants to try a different one. Features
-- are computed at TRAIN time (@homecsi/box, reusing @homecsi/features'
-- parseCsiAmplitudes/computeWindowFeature -- amplitude-first, never
-- assuming a fixed subcarrier count, same as the rest of this system) from
-- these preserved raw rows.
--
-- Source query for `preserveWindow`/`countRows` (see @homecsi/box's
-- preservation.ts) joins `csi_records` to `nodes` and filters
-- `n.role = 'box'` -- this is the READ half of the structural node-role
-- fence brief B1 adds (the WRITE half being @homecsi/features' own query
-- filtering to `role = 'house'`). See docs/box-experiment.md for why this
-- fence, not a comment, is what actually prevents a box gesture ever
-- contaminating whole-house occupancy training data or vice versa.
--
-- Idempotently keyed on (session_id, time, node_id, link_mac) -- one take's
-- window is scoped to its own session_id, so re-attempting an
-- already-preserved take (the `box preserve` CLI sweep backstop, or a retry
-- after a transient failure) is a cheap `ON CONFLICT DO NOTHING` no-op.
-- `session_id` must be part of the key (unlike `training_features`'
-- unscoped (time, node_id, link_mac) primary key): a box take's own window
-- is only ~a few seconds wide and, in principle, could overlap another
-- take's window in wall-clock time (e.g. two takes recorded back-to-back
-- with the lead-in/lead-out trim applied differently, or an operator
-- correcting a mis-stopped take), so the natural per-record identity here
-- is "this row, as captured for THIS take", not "this row, globally".
--
-- Plain relational table, NOT a hypertable, and this migration adds NO
-- retention or compression policy -- same reasoning as `training_features`/
-- `event_annotations` (migrations 007/009): preserved volume is bounded by
-- how many takes an operator records by hand, not by ingest rate, so there
-- is no partitioning or lifecycle-management benefit at this scale.
--
-- ON DELETE CASCADE on session_id: deleting a `box_sessions` row (the API's
-- `DELETE /api/box/sessions/:id`, docs/box-experiment.md) deletes its
-- preserved records too -- a take carries no occupancy assertion and no
-- append-only training-corpus guarantee (unlike `labels`), so a hold-to-
-- record UI's inevitable mis-taps must be fully undoable, the same
-- reasoning migration 009 gives for `event_annotations` being deletable.
-- ---------------------------------------------------------------------
DO $sql$
BEGIN
  EXECUTE $ddl$
    CREATE TABLE box_take_records (
      session_id bigint NOT NULL REFERENCES box_sessions(id) ON DELETE CASCADE,
      time timestamptz NOT NULL,
      node_id integer NOT NULL REFERENCES nodes(id),
      link_mac macaddr NOT NULL,
      rssi smallint NOT NULL,
      csi_format smallint NOT NULL,
      csi_data bytea NOT NULL,
      preserved_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, time, node_id, link_mac)
    )
  $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not create box_take_records.
Original error: %', SQLERRM;
END
$sql$;

-- ---------------------------------------------------------------------
-- idx_box_take_records_session: supports every read this package does --
-- `countRows`/`countPreserved`/`fetchPreserved` (@homecsi/box) all filter by
-- `session_id` first, then order by `time` for feature-window
-- reconstruction at train time.
-- ---------------------------------------------------------------------
DO $sql$
BEGIN
  EXECUTE $ddl$ CREATE INDEX idx_box_take_records_session ON box_take_records (session_id, time) $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not create idx_box_take_records_session.
Original error: %', SQLERRM;
END
$sql$;
