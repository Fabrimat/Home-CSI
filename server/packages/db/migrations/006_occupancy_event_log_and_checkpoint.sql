-- Turns `occupancy_states` from a per-tick sample log into a sparse
-- *event* log, and gives the occupancy pipeline its own read checkpoint.
--
-- Why: the pipeline used to write one row per 500 ms feature tick — about
-- 173k rows/day (~18 GB/year) to record something that is semantically
-- ~10-30 events/day ("when, and how many people"). The long-term record we
-- actually want is the transitions, stored as diffs and kept essentially
-- forever. See server/packages/occupancy/README.md for the full write
-- semantics; this migration is only the schema side of that change.
--
-- Two things follow from sparse writes, and both are load-bearing:
--
--  1. A pure diff stream cannot distinguish "nobody moved for eight hours"
--     from "the pipeline was down for eight hours" — so the pipeline also
--     emits a periodic *keepalive* row. `row_kind` makes the two kinds
--     machine-distinguishable. `state` is deliberately left as the free
--     text migration 002 describes (the state-machine's own label, which
--     brief B4 may evolve without a migration); overloading it with a
--     second meaning would break that.
--
--  2. The old design derived both the latch's resume state *and* the read
--     cursor into `features` from "the most recent occupancy_states row".
--     With sparse rows that is actively dangerous: the most recent row is
--     the last *transition*, not the last tick *processed*, so every rerun
--     would replay every tick since that transition and — the latch being
--     deterministic — re-derive and re-INSERT the same transitions as
--     duplicates, corrupting the very forever-log this change exists to
--     build. Hence `occupancy_checkpoint` below, which the pipeline
--     updates in the same transaction as the INSERT.

-- ---------------------------------------------------------------------
-- Precondition: `occupancy_states` must be empty (or already cleaned).
--
-- This migration changes what a row in this table *means*: from a sample
-- taken every 500 ms to an event that only exists because something
-- changed. Rows written by the old dense writer are not events and cannot
-- be relabelled as any of the values `row_kind` admits — there is no
-- honest answer to "was this 500 ms sample a transition or a keepalive".
--
-- So this is checked up front and refused with an actionable message,
-- rather than letting the DDL below fail with a raw
-- `column "row_kind" contains null values` (or a raw unique violation on
-- duplicate timestamps), which tells an operator nothing about what the
-- rows are or what to do with them.
--
-- Note for readers comparing this with migration 007, which says
-- pre-existing dense rows are "left as-is": 007 runs *after* this
-- migration, so its statement only ever describes a database that already
-- got past the check below. On a database that actually holds dense rows,
-- their fate is decided here — truncate or clean them before 006 applies —
-- and 007 then correctly leaves the (now sparse, or empty) table alone.
-- ---------------------------------------------------------------------
DO $precondition$
DECLARE
  total_rows bigint;
  duplicate_times bigint;
BEGIN
  SELECT count(*) INTO total_rows FROM occupancy_states;
  IF total_rows = 0 THEN
    RETURN;
  END IF;

  SELECT count(*) INTO duplicate_times
  FROM (SELECT time FROM occupancy_states GROUP BY time HAVING count(*) > 1) duplicated;

  RAISE EXCEPTION 'Migration 006 requires occupancy_states to be empty, but it holds % row(s), of which % timestamp(s) occur more than once.

Those rows were written by the previous per-tick writer: one sample every
500 ms. This migration turns the table into a sparse event log (one row per
state transition, plus a keepalive every 15 minutes of tick time), so every
row needs a row_kind of transition or keepalive - and a per-tick sample is
neither. It also needs one row per instant, which per-tick rows may violate.

Pick one, then re-run the migration:

  1. Recommended, and safe on this pre-launch project (docs/architecture.md
     "Status"): throw the samples away. They are dev/staging data, and the
     features they were derived from are still there.

       TRUNCATE occupancy_states;

  2. Keep them: backfill a row_kind for every row and remove duplicate
     timestamps yourself, e.g.

       ALTER TABLE occupancy_states ADD COLUMN row_kind text;
       UPDATE occupancy_states SET row_kind = ''transition'' WHERE row_kind IS NULL;
       DELETE FROM occupancy_states a USING occupancy_states b
         WHERE a.time = b.time AND a.ctid > b.ctid;

     then re-run. Be aware this labels samples as transitions, which is a
     lie the log will carry forever - see server/packages/occupancy/README.md
     before choosing this.', total_rows, duplicate_times;
END
$precondition$;

-- ---------------------------------------------------------------------
-- occupancy_states.row_kind
--
-- 'transition' — the estimate and/or the latch's internal state label
--                changed at this tick. Carries the usual `details` payload.
-- 'keepalive'  — nothing changed, but enough tick time has passed that the
--                log needs proof the pipeline was running and observing.
--                Deliberately thin: `details` is NULL, because resume now
--                reads occupancy_checkpoint instead of details.latchState.
--
-- Added NOT NULL with no default, matching migration 004's precedent and
-- for the same reason: this is a pre-launch, greenfield project
-- (docs/architecture.md "Status") with no rows in this hypertable in any
-- real deployment. The precondition above is what makes that assumption
-- explicit instead of implicit.
-- ---------------------------------------------------------------------
DO $policy$
BEGIN
  EXECUTE $sql$ ALTER TABLE occupancy_states ADD COLUMN row_kind text NOT NULL $sql$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not add occupancy_states.row_kind as NOT NULL.

The usual cause is rows written by the previous per-tick writer, which have
no honest row_kind (they are 500 ms samples, not events). Either
TRUNCATE occupancy_states, or backfill row_kind yourself, then re-run - see
the precondition block at the top of this migration for the exact commands.
Original error: %', SQLERRM;
END
$policy$;

ALTER TABLE occupancy_states
  ADD CONSTRAINT occupancy_states_row_kind_check
  CHECK (row_kind IN ('transition', 'keepalive'));

-- One row per instant, enforced rather than assumed. The old design was
-- *accidentally* idempotent (the row was the checkpoint, written by a
-- single INSERT); now that the checkpoint is a separate write, this index
-- plus the pipeline's ON CONFLICT (time) DO NOTHING is the belt to the
-- transaction's braces. TimescaleDB requires any unique index on a
-- hypertable to include the partitioning column — here that is `time`
-- itself, which is also the whole key: occupancy is whole-house, so there
-- is at most one state per instant.
DO $policy$
BEGIN
  EXECUTE $sql$ CREATE UNIQUE INDEX idx_occupancy_states_time ON occupancy_states (time) $sql$;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'Could not create the unique index on occupancy_states (time).

The usual cause is duplicate timestamps among rows written by the previous
per-tick writer. One instant means one whole-house state, so the duplicates
have to go before this log can be trusted: TRUNCATE occupancy_states, or
de-duplicate by timestamp yourself, then re-run - see the precondition block
at the top of this migration for the exact commands.
Original error: %', SQLERRM;
END
$policy$;

-- ---------------------------------------------------------------------
-- occupancy_checkpoint: singleton row, the occupancy pipeline's resume
-- point. Not a hypertable and not time-series data — it is exactly one
-- row that is overwritten in place, enforced by the `singleton` primary
-- key (`boolean PRIMARY KEY CHECK (singleton)` admits only `true`).
--
-- `last_tick_ms` is the *processing* cursor (last `features` tick fed to
-- the latch); `last_written_tick_ms` / `last_estimate` / `last_state`
-- describe the last row actually appended to `occupancy_states`. The two
-- are different by design and both are needed: the first stops reruns
-- replaying ticks, the second lets the change detector and the keepalive
-- clock survive a restart without reading the log back.
--
-- Epoch milliseconds (bigint) rather than timestamptz because that is the
-- unit the latch itself works in (@homecsi/occupancy stateMachine.ts) —
-- storing it as a timestamp would mean a lossy round trip on every run.
-- ---------------------------------------------------------------------
CREATE TABLE occupancy_checkpoint (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_tick_ms bigint NOT NULL,
  latch_state jsonb NOT NULL,
  last_written_tick_ms bigint,
  last_estimate smallint,
  last_state text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE occupancy_checkpoint IS
  'Singleton resume point for the occupancy pipeline. Updated in the same transaction as the occupancy_states INSERT — see @homecsi/occupancy pipeline.ts.';
