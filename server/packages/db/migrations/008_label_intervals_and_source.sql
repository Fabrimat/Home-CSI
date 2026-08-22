-- Extends `labels` (migration 002) with an optional interval end and
-- explicit label provenance, for the dashboard's feedback loop (briefs
-- B12-B15, docs/architecture.md "Data lifecycle").
--
-- Why intervals: `packages/labeling/src/datasetExport.ts` emits one
-- training row per label. A point-only label means an operator correcting
-- a 2-hour stretch of wrong occupancy produces exactly ONE training row --
-- an interval label (`end_time`, EXCLUSIVE) lets a future export expand it
-- into one row per feature window inside the interval instead. `end_time`
-- is nullable: NULL means "point label", exactly the existing behaviour,
-- so every point label already in the table (and every future one that
-- never sets it) needs no migration of its own meaning.
--
-- Why provenance as a real column, not just the existing notes-prefix
-- convention: `WEAK_LABEL_PREFIX` (packages/labeling/src/sessions.ts) has
-- always been a string-convention workaround, documented there as a
-- KNOWN LIMITATION -- a stored `source` column lets every future consumer
-- (the API, the dashboard, dataset export) ask "how was this label
-- produced" directly instead of pattern-matching free text. The
-- notes-prefix convention is NOT removed here -- @homecsi/labeling still
-- writes it alongside the new column (see sessions.ts) so nothing that
-- already reads it regresses; `source` is the new, authoritative way to
-- ask the same question.

-- ---------------------------------------------------------------------
-- end_time: nullable, EXCLUSIVE end of the labelled interval. NULL means
-- "point label" (the existing, unchanged meaning of a bare `time`). Added
-- with no CHECK yet -- the CHECK constraint below needs a moment (via
-- `source`'s backfill) before it can be added meaningfully; see that
-- section's comment for why the ordering here is deliberate.
-- ---------------------------------------------------------------------
DO $sql$
BEGIN
  EXECUTE $ddl$ ALTER TABLE labels ADD COLUMN end_time timestamptz $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add labels.end_time.
Original error: %', SQLERRM;
END
$sql$;

-- ---------------------------------------------------------------------
-- source: explicit provenance, NOT NULL DEFAULT 'manual'. The default
-- means every pre-existing row -- all of which predate this column and
-- are, without exception, either a manually-typed label or a weak
-- phone-presence probe (the only two label-producing code paths that have
-- ever existed, per @homecsi/labeling) -- starts out reading as 'manual'.
-- That default is intentionally provisional: the backfill immediately
-- below corrects every row that is actually a weak label before the CHECK
-- constraint (further below) locks the column down.
-- ---------------------------------------------------------------------
DO $sql$
BEGIN
  EXECUTE $ddl$ ALTER TABLE labels ADD COLUMN source text NOT NULL DEFAULT 'manual' $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add labels.source.
Original error: %', SQLERRM;
END
$sql$;

-- ---------------------------------------------------------------------
-- Backfill, BEFORE the CHECK constraint below -- deliberately, not
-- incidentally. Backfilling after adding the CHECK would still work (the
-- CHECK only restricts future values; an UPDATE re-validates every
-- touched row against it), but doing it first makes the intent
-- unambiguous to a future reader: the DEFAULT above is a placeholder for
-- rows this migration hasn't looked at yet, not a claim that every
-- pre-existing row really is manual. `starts_with` mirrors `isWeakLabel`'s
-- own `String.prototype.startsWith` check (packages/labeling/src/
-- sessions.ts) exactly, against the same `WEAK_LABEL_PREFIX` constant
-- ('[weak:phone-presence]') -- any row whose `notes` starts with it was
-- produced by `label presence probe`, not typed by a human, regardless of
-- how old the row is.
-- ---------------------------------------------------------------------
UPDATE labels
SET source = 'weak:phone-presence'
WHERE notes IS NOT NULL AND starts_with(notes, '[weak:phone-presence]');

-- ---------------------------------------------------------------------
-- CHECK constraints, added last: end_time must be strictly after time (or
-- NULL -- a point label), and source must be one of the four provenance
-- values @homecsi/labeling and the API ever write. Both are added only
-- now that the backfill above has already corrected every existing row,
-- so neither constraint is "trivially satisfied by a DEFAULT that lies"
-- -- it is satisfied by data that has actually been looked at.
-- ---------------------------------------------------------------------
DO $sql$
BEGIN
  EXECUTE $ddl$
    ALTER TABLE labels ADD CONSTRAINT labels_end_time_after_time_check
      CHECK (end_time IS NULL OR end_time > time)
  $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add the labels.end_time > time CHECK constraint.
The usual cause is one or more existing rows with an end_time at or before
their own time -- inspect them with:
  SELECT id, time, end_time FROM labels WHERE end_time IS NOT NULL AND end_time <= time;
and correct or null out end_time on those rows, then re-run.
Original error: %', SQLERRM;
END
$sql$;

DO $sql$
BEGIN
  EXECUTE $ddl$
    ALTER TABLE labels ADD CONSTRAINT labels_source_check
      CHECK (source IN ('manual', 'weak:phone-presence', 'confirmed', 'training'))
  $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add the labels.source CHECK constraint.
The usual cause is one or more existing rows whose source (after the
backfill above) is not one of ''manual'', ''weak:phone-presence'',
''confirmed'', or ''training'' -- inspect them with:
  SELECT id, source FROM labels WHERE source NOT IN (''manual'', ''weak:phone-presence'', ''confirmed'', ''training'');
and correct them, then re-run.
Original error: %', SQLERRM;
END
$sql$;

-- ---------------------------------------------------------------------
-- idx_labels_time_range: supports the new overlap query
-- (GET /api/labels?from&to, packages/api/src/routes/labels.ts) --
-- `time < $to AND COALESCE(end_time, time) >= $from` -- across ALL
-- sessions, which idx_labels_session_time (migration 002, keyed by
-- session_id first) cannot serve well. idx_labels_time (migration 002)
-- stays: it still serves plain "labels after this instant" queries and
-- existing callers are unchanged.
--
-- `labels` is a plain relational table, not a hypertable (migration 002)
-- -- ground truth is permanent, not subject to any retention or
-- compression policy, and this migration adds neither.
-- ---------------------------------------------------------------------
DO $sql$
BEGIN
  EXECUTE $ddl$ CREATE INDEX idx_labels_time_range ON labels (time, end_time) $ddl$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not create idx_labels_time_range.
Original error: %', SQLERRM;
END
$sql$;
