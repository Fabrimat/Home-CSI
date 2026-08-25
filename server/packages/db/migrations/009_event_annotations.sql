-- Adds `event_annotations`: a categorised, point-or-interval marker that
-- says "something happened here" WITHOUT asserting an occupancy count
-- (brief B1, docs/architecture.md "Motion, not people"). Motivating case:
-- an operator wants to record "that spike at 19:42 is the microwave", which
-- today is impossible without lying about occupancy -- `labels.occupancy_
-- count` is `smallint NOT NULL` (migration 002), so recording a microwave
-- would force asserting a people count for something that isn't a person.
-- That would poison the training corpus with a false ground-truth row --
-- exactly what "motion, not people" (CLAUDE.md) exists to prevent.
--
-- Why a NEW table, not a nullable `occupancy_count` + a `kind` discriminator
-- bolted onto `labels`: `packages/labeling/src/datasetExport.ts`'s
-- `resolveTickConflicts` resolves overlapping labels at the same tick by
-- "highest labelId wins", across ALL rows in `labels` -- it has no concept
-- of "this row isn't really ground truth, skip it". If an annotation lived
-- in `labels`, one export call that forgot to filter it out would let a
-- microwave annotation *outrank and silently displace* a real correction's
-- rows at any tick they share -- ground truth quietly deleted from the
-- dataset, not merely diluted with noise. A structurally separate table
-- makes that entire class of bug impossible: `resolveTickConflicts` and
-- everything upstream of it only ever sees `labels` rows, so an annotation
-- can never outrank one.
--
-- Why no `activity` category: "a person cooking" (or vacuuming, or doing
-- laundry while home) IS occupancy signal, not a confounder to explain away
-- -- it belongs in `labels` via the existing `POST /api/labels/corrections`
-- flow. An `activity` category here would split occupancy-relevant ground
-- truth across two tables, one of which (`event_annotations`) the dataset
-- exporter never reads -- a future analyst asking "was anyone doing
-- something at this time" would get an incomplete answer depending on which
-- table happened to hold the row. The six categories below (`appliance`,
-- `door`, `hvac`, `pet`, `interference`, `other`) are deliberately all
-- *non-occupant* RF confounders; `label`/`notes` are the free-text pressure
-- valve for whatever the CHECK'd vocabulary doesn't name.
--
-- Why NO `session_id` and NO feature-preservation path -- considered and
-- rejected, spelled out here because it is exactly the kind of thing a
-- future reader will try to "fix":
--   * An annotation's job is explaining the *forever* log
--     (`occupancy_states`, migration 006/007 -- no retention policy) --
--     "that 19:42 false-positive latch was the microwave" stays meaningful
--     forever with zero preserved raw features, because understanding it
--     later never depends on replaying the microwave's own CSI.
--   * Creating a per-annotation `label_sessions` row just to reuse
--     `preserveSessionFeatures` (the way `POST /api/labels/corrections`
--     does) would break two things that already exist and already work:
--     `packages/web/ui/src/views/training.ts`'s `findOpenTrainingSession`
--     scans `/api/labels/sessions?limit=500` (the hard `MAX_SESSIONS_LIMIT`,
--     packages/api/src/routes/labels.ts) newest-first for the open
--     `[training]` session -- a high-volume one-tap annotation UI would push
--     real training sessions past that cap and silently orphan an
--     in-progress training walk. And `packages/labeling/src/index.ts`'s
--     `label preserve` sweep iterates every session, forever -- every
--     annotation would add a permanent per-run round-trip to a sweep that
--     is supposed to be bounded by how much a human actually labels, not by
--     how many confounders they tap.
--   * Even ignoring the above, a point annotation would preserve only
--     ~`config.features.windowMs` (about 2 seconds) of raw features -- far
--     too short a slice to ever function as a usable confounder signature.
--   * When a confounder genuinely matters to training, it matters as a hard
--     negative for the occupancy target ("the house was empty and this
--     spike happened anyway") -- which needs a real occupancy label, and
--     that path already exists and is already fully plumbed:
--     `POST /api/labels/corrections` with `occupancyCount: 0`.
--
-- Plain relational table, like `labels` (migration 002/008) -- NOT a
-- hypertable, and this migration adds no retention or compression policy.
-- Annotations are permanent (they annotate `occupancy_states`, which itself
-- has no retention policy -- migration 007) and are expected to stay small:
-- volume is bounded by how much an operator actually taps, not by an
-- ingest rate.
--
-- Fresh table, no existing rows to backfill -- unlike migration 008's
-- ALTER-then-backfill-then-CHECK dance on `labels`, every constraint here
-- can go straight into the CREATE TABLE statement. Still split into two
-- DO $sql$/EXCEPTION blocks (table, then index), mirroring migration 008's
-- one-block-per-DDL-statement style and its helpful, inspectable failure
-- messages.
-- ---------------------------------------------------------------------
DO $sql$
BEGIN
  EXECUTE $ddl$
    CREATE TABLE event_annotations (
      id bigserial PRIMARY KEY,
      time timestamptz NOT NULL,
      -- EXCLUSIVE end, NULL means a point event -- identical semantics to
      -- labels.end_time (migration 008).
      end_time timestamptz,
      category text NOT NULL,
      -- Short free-text human name ("microwave", "washing machine") -- the
      -- pressure valve for vocabulary the category CHECK doesn't cover.
      label text,
      notes text,
      -- 'manual' is the only value any code path writes today. Kept as a
      -- real column (not hardcoded) so a future automated-detection source
      -- can be added the same way migration 008 added labels.source's
      -- 'weak:phone-presence' -- by widening this CHECK, not by
      -- restructuring the table.
      source text NOT NULL DEFAULT 'manual',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT event_annotations_end_time_after_time_check
        CHECK (end_time IS NULL OR end_time > time),
      CONSTRAINT event_annotations_category_check
        CHECK (category IN ('appliance', 'door', 'hvac', 'pet', 'interference', 'other')),
      CONSTRAINT event_annotations_source_check
        CHECK (source IN ('manual'))
    )
  $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not create event_annotations.
Original error: %', SQLERRM;
END
$sql$;

-- ---------------------------------------------------------------------
-- idx_event_annotations_time_range: supports the overlap query
-- (GET /api/annotations?from&to, packages/api/src/routes/annotations.ts) --
-- `time < $to AND COALESCE(end_time, time) >= $from` -- the exact same
-- predicate shape as idx_labels_time_range (migration 008) serves for
-- `labels`, for the same reason: without it, every range query full-scans
-- `event_annotations`.
-- ---------------------------------------------------------------------
DO $sql$
BEGIN
  EXECUTE $ddl$ CREATE INDEX idx_event_annotations_time_range ON event_annotations (time, end_time) $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not create idx_event_annotations_time_range.
Original error: %', SQLERRM;
END
$sql$;
