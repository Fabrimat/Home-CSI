# @homecsi/occupancy

Owned by brief B4 (features/occupancy). Implements the latched occupancy
state machine described in `docs/architecture.md`. See
`server/packages/cli/CONTRACTS.md` for this package's exact exported
function contract (`runOccupancyPipeline`).

Two modules:

- `stateMachine.ts` — the pure, DB-free latch (motion, not people: a
  still occupant looks like an empty house on any single window, so the
  machine integrates motion transitions over time instead of classifying
  each window).
- `pipeline.ts` — reads the `features` hypertable, drives the latch tick
  by tick, and appends to `occupancy_states`.

## Write semantics: `occupancy_states` is a sparse event log

The pipeline used to write **one row per 500 ms feature tick** — roughly
173k rows/day, ~18 GB/year, to record something that is semantically about
10–30 events a day. Since migration 006 it writes **transitions only**,
kept essentially forever:

- **Transition rows** (`row_kind = 'transition'`) — emitted only when the
  `estimate` or the latch's internal `state` label differs from the last
  row written. Carry the usual `details` payload (latch state, active
  links, multi-occupancy evidence, data sufficiency), so every event can
  still explain itself.
- **Keepalive rows** (`row_kind = 'keepalive'`) — emitted when the last
  written row is older than `KEEPALIVE_INTERVAL_MS` (15 minutes). A pure
  diff stream cannot tell "nobody moved for eight hours" from "the
  pipeline was down for eight hours"; the keepalive is what makes that
  distinction possible. Deliberately **thin**: `details` is `NULL`,
  because resume reads `occupancy_checkpoint`, not `details.latchState`.
- The keepalive clock runs on **tick time, not wall-clock time.** This
  pipeline is a one-shot batch CLI, not a daemon — "now" is meaningless to
  it. A keepalive is emitted when the current tick's timestamp is at least
  one interval past the last written row.
- **A batch with zero feature ticks writes nothing at all**, not even a
  keepalive, and does not touch the checkpoint. A gap in the log therefore
  honestly means "there were no whole-house observations in this period".
- The first tick after a virgin install always writes one row, to
  establish the baseline state the later diffs are relative to.

Consumers must read this with **step semantics**: a row's value holds until
the next row (last value carried forward). Never interpolate between rows,
never assume a cadence, and never treat "no rows in my window" as "no
data" — ask for the carry-in row (`GET /api/occupancy` returns it
automatically; see `packages/api/src/routes/occupancy.ts`).

## `occupancy_checkpoint`, and why it must be transactional

The old design derived both the latch's resume state and the read cursor
into `features` from "the most recent `occupancy_states` row", and called
avoiding a checkpoint table a design win. Sparse writes invalidate that,
and not merely on efficiency grounds: `occupancy_states` has no unique
constraint on `time` (before migration 006) and the write was a plain
`INSERT`, so with sparse rows a cursor of "time of the last written row"
makes every rerun replay every tick since the last *transition* — and
because the latch is deterministic, re-derive and re-`INSERT` those same
transitions as duplicates, corrupting the very forever-log this design
exists to build.

So the singleton `occupancy_checkpoint` row holds:

| column | meaning |
| --- | --- |
| `last_tick_ms` | exclusive read cursor: the last `features` tick fed to the latch |
| `latch_state` | the latch's internal state after that tick |
| `last_written_tick_ms`, `last_estimate`, `last_state` | the last row appended to `occupancy_states` — the change detector and keepalive clock survive a restart |

**The `occupancy_states` INSERT and the checkpoint write happen in one
transaction** (`BEGIN` / … / `COMMIT`, rolling back on any error). The old
single-INSERT design was *accidentally* atomic because the row was the
checkpoint; splitting them without a transaction would reintroduce
duplicate transitions whenever a process died between the two. Belt and
braces on top of that: migration 006 adds a unique index on
`occupancy_states (time)` and the INSERT uses `ON CONFLICT (time) DO
NOTHING`.

## Decision: replay is features-only

Reprocessing raw captures (`homecsi replay`) re-derives `csi_records` and
`features`. It **does not rewrite `occupancy_states`.** The occupancy log
is append-only and is never deleted or recomputed as a side effect of a
replay.

Why: this table is the long-term record of "when, and how many people".
Making it a function of how many times raw captures happened to be
reprocessed would mean the history of the house changes underneath anyone
reading it, silently. A delete-and-recompute is a destructive operation
and should be an explicit, deliberate one — not a side effect of a
recovery step.

The practical consequence, stated plainly: a replay that inserts `features`
rows *older* than `occupancy_checkpoint.last_tick_ms` will never be seen by
the occupancy pipeline, because its cursor only moves forward. If you do
want to recompute occupancy for a period, that is a manual operation —
delete the range from `occupancy_states` and rewind (or delete)
`occupancy_checkpoint` — and there is no CLI command for it in v1, on
purpose.

## Decision: confidence is stored, not re-ramped client-side

While the latch is `DECAYING`, confidence ramps continuously from 0.85 down
to 0.4 as the silence approaches `latchDecayHorizonMs`. With sparse writes
the *stored* value only updates on a transition or a keepalive, so it can
be up to one keepalive interval (15 minutes) behind the continuous ramp.

**The UI displays the stored value, labelled with when it was recorded**
("confidence 62% as recorded 12 minutes ago"). It does not recompute the
ramp in the browser.

Why: recomputing would put a second copy of the state machine's decay
arithmetic in the frontend, where it would need `latchDecayHorizonMs` (not
exposed to the browser today) and would silently drift from the real
machine the first time the ramp changes. The staleness is bounded at one
keepalive interval by construction, and a keepalive refreshes `confidence`
along with everything else — so the honest, cheap answer is to show the
recorded number and say when it was recorded. If the UI ever needs a
smoother readout, the right fix is to shorten the keepalive interval or
expose the horizon, not to fork the arithmetic.

## Latch hygiene (things sparse writing made dangerous)

- **Stale-link eviction.** A link keeps its per-link Schmitt state across
  ticks where it simply didn't report ("no new data" is not "confirmed
  quiet") — but only up to `latchDecayHorizonMs`. Past that the link is
  evicted. Without this, a node unplugged mid-motion keeps `anyActive`
  true forever, which refreshes `lastMotionAtMs` every tick and latches the
  house `OCCUPIED` permanently. That bug predates this change; sparse
  writing makes it both more consequential (the eternal `OCCUPIED` becomes
  the stored record) and less visible (no rows = no sign anything is
  wrong).
- **Bounded `details`.** Quiet links are deleted from `linkActive` rather
  than stored as `false`, so the persisted JSONB cannot accrete every link
  key ever seen.
