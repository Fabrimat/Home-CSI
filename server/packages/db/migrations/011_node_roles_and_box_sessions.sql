-- Two independent additions for brief B1's box-experiment plumbing
-- (docs/architecture.md is deliberately silent on the box experiment
-- itself -- this migration only lays the shared DB groundwork sibling
-- brief B3 builds on):
--
-- 1. `nodes.role` -- a DATA-FLOW FENCE, not a label. 5 new ESP32-C6 nodes
--    are being wired around a closed box for hand-presence/gesture
--    experiments, talking to the SAME ingest as the house nodes. Without
--    this column (and the join against it @homecsi/features's pipeline
--    query adds -- see packages/features/src/pipeline.ts's
--    createPgCsiRecordSource), a hand waved in front of a box node would
--    flow straight into the features pipeline and from there into the
--    latched occupancy state machine, permanently corrupting
--    `occupancy_states` -- the one table this project keeps forever with
--    no retention policy (migration 007). Defaults to 'house' so every
--    existing row (and every node an operator forgets to annotate in
--    config.yaml) is fenced IN, never silently fenced out. Mirrors
--    packages/config/src/schema.ts's `nodeSchema.role` field exactly --
--    see that field's comment for the full rationale; this migration only
--    adds the storage for it, the same split migration 010 used for
--    floor/position.
--
-- 2. `box_sessions` -- a plain relational table recording one row per
--    "recording take" at the box (started_at/ended_at, which gesture class
--    was being demonstrated, free-text geometry/notes). Owned end-to-end
--    by sibling brief B3, which gets this exact DDL verbatim in its own
--    brief; created here (not there) because two OTHER pieces of this
--    brief's own plumbing need to read it before B3 exists: ingest's
--    persisted-rate ceiling bypass (an open row lets role='box' nodes
--    write at full burst rate -- @homecsi/ingest's persistedRateLimiter.ts)
--    and the dashboard's live view (packages/api/src/live/hub.ts polls for
--    an open row to speed up the `csi` channel while a take is running).
--    Like `event_annotations` (migration 009) and `labels`/`label_sessions`
--    (migration 002/008), this is bounded by operator taps, not an ingest
--    rate -- no retention or compression policy, expected to stay small
--    and permanent.
-- ---------------------------------------------------------------------

DO $sql$
BEGIN
  EXECUTE $ddl$ ALTER TABLE nodes ADD COLUMN role text NOT NULL DEFAULT 'house' $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add nodes.role.
Original error: %', SQLERRM;
END
$sql$;

DO $sql$
BEGIN
  EXECUTE $ddl$
    ALTER TABLE nodes ADD CONSTRAINT nodes_role_check CHECK (role IN ('house', 'box'))
  $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add nodes_role_check.
Original error: %', SQLERRM;
END
$sql$;

DO $sql$
BEGIN
  EXECUTE $ddl$
    CREATE TABLE box_sessions (
      id            bigserial PRIMARY KEY,
      started_at    timestamptz NOT NULL DEFAULT now(),
      ended_at      timestamptz,
      gesture_class text NOT NULL,
      geometry_note text,
      notes         text
    )
  $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not create box_sessions.
Original error: %', SQLERRM;
END
$sql$;

-- Supports the two "is a take currently running" checks above (ingest's
-- ~1/s poll, LiveHub's poll) -- both run `WHERE ended_at IS NULL LIMIT 1`,
-- which this partial index answers without scanning the whole table.
DO $sql$
BEGIN
  EXECUTE $ddl$
    CREATE INDEX box_sessions_open_idx ON box_sessions (started_at DESC) WHERE ended_at IS NULL
  $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not create box_sessions_open_idx.
Original error: %', SQLERRM;
END
$sql$;
