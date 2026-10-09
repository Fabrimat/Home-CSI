# The box experiment

## Status

Recreational side-experiment, built by brief B3 on top of the node-role
fence brief B1 adds to the base schema (migration 011). Nothing here feeds
occupancy, and occupancy never feeds this. See `server/packages/cli/
CONTRACTS.md` for the `box` CLI surface and `@homecsi/box`'s own README for
the package layout.

## What this is

Five ESP32-C6 nodes sit around a closed box. The operator records short,
labelled "takes" -- a hold-to-record of one hand gesture near/in the box
(a fist, an open hand, fingers waved, the box left empty as a control,
whatever vocabulary the operator invents) -- and offline, a simple k-NN
classifier tries to tell the gestures apart from their CSI signature. It is
built for fun and curiosity about what this hardware can resolve at close
range, not for any occupancy purpose.

## Why a per-window classifier is legitimate here, and forbidden for house occupancy

`docs/architecture.md` ("Motion, not people") is unambiguous: no per-window
classifier may claim to answer "how many people are home right now", because
a still occupant and an empty room produce the same instantaneous CSI
window. That rule is about **the claim being made**, not about the
technique of windowing-and-classifying itself:

- A house-occupancy classifier would claim something about **how many
  people are in a home, right now, at room scale** -- a claim CSI genuinely
  cannot support on a single window, because stillness is indistinguishable
  from absence.
- A box-gesture classifier claims something much narrower: **which of a
  small, fixed vocabulary of hand shapes/motions was closest to a box, at
  ~30cm range, during a few seconds an operator deliberately held it
  there.** It makes no claim about occupancy, presence, or how many people
  are anywhere. It is evaluated against ground truth the operator supplied
  themselves (the gesture they just performed), not inferred and then
  trusted.

Same underlying radios, same amplitude-first pipeline, same "CSI is noisy
and ambiguous" caveats -- but a completely different question being asked of
it. That is what makes a per-window classifier honest here and dishonest
there: **the claim, not the math.**

## The structural fence (and what is NOT the fence)

This paragraph is not the fence. Writing "box data must never train an
occupancy model" here is a comment, and comments get skipped, forgotten, or
copy-pasted past during a refactor six months from now. The actual fence is
structural, built by brief B1 and enforced at the query layer both packages
share:

- `nodes.role` (migration 011, `CHECK IN ('house', 'box')`) tags every node
  at the schema level as belonging to the whole-house mesh or the box rig,
  never both.
- `@homecsi/features`' own `csi_records` query filters to `role = 'house'`
  -- box nodes' CSI cannot reach the whole-house feature pipeline,
  occupancy state machine, or training corpus through any *code* path, no
  matter what a future caller does or forgets to do: a new query that skips
  this filter, or a refactor that moves it, is exactly the class of mistake
  this choke point exists to make impossible.
- `@homecsi/box`'s own preservation query (`preservation.ts`) filters the
  same table the other direction, to `role = 'box'` -- so a box take's
  `box_take_records` can only ever contain CSI from box-role nodes, never
  house nodes.
- **`@homecsi/box` is never imported by `@homecsi/features` or
  `@homecsi/occupancy`** -- enforced by a guard brief B1 adds that fails the
  build if it ever is. There is no import path by which a line of code in
  this package could reach the occupancy pipeline even if someone tried.

Two independent `role` filters plus an import-graph guard mean contamination
in either direction requires a schema change (`nodes.role`'s CHECK
constraint), not just a careless line of application code. That is the
difference between "a rule documented in a doc" and "a rule the system
cannot violate without someone deliberately widening the schema" -- this
doc explains the fence; it does not implement it.

**What the filter selects on is the *observer*, not the source MAC.**
`@homecsi/features`' query joins `nodes` on `csi_records.node_id` -- the
node that *captured* the frame -- and keeps `role = 'house'`. It says
nothing about `src_mac`, the peer whose frame was decoded. So a house node
that hears a box node's sounding still produces an ordinary house
`features` row, on the link `(house node, box node's MAC)`, and that row is
inside the fence like any other. **That is correct, and not a leak.** A
house node is a house vantage point no matter whose frame it happened to
decode: that link runs across a room from a fixed house node, it measures
the house's own multipath, and a person standing at the bench waving a hand
at the box genuinely is home -- an occupancy latch off that link is a true
positive, not corruption. What carries no house-occupancy information is a
link whose *both* ends sit inside a closed box at ~30cm, and excluding
exactly those is what an observer-side filter does: a box node's own
records never reach `features` at all. Filtering `src_mac` too would
discard true observations made by house sensors, which is not what this
fence is for.

**A realtime box burst does not leak in through those links either.** Box
nodes sound much faster during a take, but two independent ceilings apply
to the house node that hears them, and neither knows or cares that the
frame came from a box node:

- **Node side.** Unless the box MACs are on that house node's allowlist,
  its firmware classes those frames as `BW_CLASS_FOREIGN`
  (`csi_capture.c`'s `classify_source`), a class with its own small token
  bucket -- 5 records/s, burst 20 by default (`bw_budget.c`'s
  `bw_budget_default_cfg`), against 50/s for soundings.
  `HCS_MAC_ALLOWLIST_ENFORCED` defaults to off, so they are kept at that
  trickle rate rather than dropped outright; turning it on drops them
  entirely.
- **Server side.** Ingest's persisted-rate ceiling keys its open-session
  bypass on the *observing* node's role (`packages/ingest/src/engine.ts`'s
  `admitForPersistence`, called with the datagram's own `node_id` and the
  record's `src_mac`), and a `role = 'house'` node is never bypassed. The
  `(house node, box MAC)` link therefore gets the ordinary per-link
  ceiling, ~50 records/s.

The dense part of a take exists only in the box nodes' own records, which
the fence excludes; what the house side sees of it is a normal-rate house
link.

**A link the pipeline has never seen reports motion it is not seeing, for
much longer than you would guess, and powering the box rig on creates such
links.** Those `(house node, box MAC)` links appear when the rig powers on
and stop when it powers off; leave it off long enough for the 7-day
`features` retention to drop that link's last row and it comes back as a
link the feature pipeline has no history for at all (`@homecsi/features`
has no checkpoint table -- it resumes a link's baseline from that link's
newest surviving `features` row). A link starting from nothing seeds its
adaptive baseline on its first window and reports deviation 0 for it by
construction, but the baseline's *variance* starts at zero, so the z-score
divisor is the numerical floor `MIN_STD_DEV` (1e-6,
`packages/features/src/baseline.ts`) rather than a real noise estimate, and
ordinary channel jitter scores far above `motionOnThreshold`. Recovery is
slower than that description suggests, because it is self-limiting: the EMA
adapts only on windows *not* classified as motion, so while the variance is
still too small most windows flag -- and a window that flags is a window
the variance does not grow on.

Measured by driving `EmaBaseline` directly with a synthetic quiet Gaussian
series containing no motion whatsoever, at `config.example.yaml`'s values
(`baselineAdaptationRate` 0.02, thresholds 3.0/1.5), over 3000 runs of 3000
windows each, the share of windows flagged as motion decays like this with
the link's age:

- windows 0-12: **~36%**
- windows 24-60: ~27%
- windows 60-120: ~20%
- windows 120-300: ~12%
- windows 300-1000: ~5%
- windows 1000-3000: ~2.7%

against **0.2%** for the same series fed to a link resuming an already-
converged baseline. So this is not a brief transient with a bound on it: it
is an elevated false-motion rate that decays over thousands of windows, and
is still an order of magnitude above the converged floor after a thousand of
them (about eight minutes at `hopMs` 500). Individual flagged episodes are
usually short (median one window, 90th percentile ten), but the tail has no
useful bound -- five runs in 3000 were still inside their *first* flagged
episode when the 25-minute series ended. Roughly half of all runs flag more
than six of their first 24 windows, averaging between eight and nine.

Those figures characterise the algorithm under synthetic i.i.d. noise; they
are not a field measurement. Real `motionEnergy` is autocorrelated and its
own shape will move the numbers. Take them as the order of the effect, not
as a specification -- the one property worth relying on is that the duration
depends on the noise the link happens to see and is not tightly bounded.

**What that means at the bench:** the occupancy latch applies its own
Schmitt trigger to the same per-link deviation
(`packages/occupancy/src/stateMachine.ts`), and a single active link is
enough to refresh `lastMotionAtMs` -- so flagging even a few percent of
windows keeps the latch fed far more often than `latchDecayHorizonMs`
(30 minutes in the example config) could ever decay it. **If the house
latches "occupied" when you power the box rig on, do not assume it is
you.** It may well be you walking to the bench -- but it may equally be
several links the pipeline has never seen before working through their first
minutes, and that can outlast the walk by a long way. The latch alone does
not distinguish them; if it matters for what you are doing, look at whether
the links reporting motion are the new `(house node, box MAC)` ones.

This is a property of any link seen for the first time (a new house node, a
replaced AP, a node returning after a long enough outage), not something the
box experiment introduces; the rig just makes it happen on a schedule, in
front of an operator who is watching. Recorded here as a known
characteristic rather than a fix in flight: a fresh link's first windows
honestly mean "not enough history to say", and the pipeline does not
currently distinguish that from "deviation".

**What the fence does NOT cover: a node registered with the wrong role.**
Everything above holds against *code* -- it says nothing about a node whose
`nodes.role` was wrong from the moment it was registered. `role` (migration
011) defaults to `'house'` when a node's `config.yaml` entry omits
`role: box` (`packages/config/src/schema.ts`'s `nodeSchema`), and ingest's
startup upsert writes exactly what `config.yaml` says, every restart. Five
new C6 nodes going into the box rig for the first time -- PSKs, positions,
and now a role, all at once -- is exactly the bring-up where one forgotten
field is likely, and a forgotten `role: box` is the single most likely way
a hand gesture at the bench ends up **inside** the fence instead of outside
it: the node's CSI reads as `role = 'house'`, flows straight through
`@homecsi/features`' filter, and latches `occupancy_states` on nothing more
than a hand waving near a box -- the exact permanent corruption this fence
exists to prevent, reached without anyone's code ever doing anything wrong.

**Bring-up ordering that actually matters:** `role: box` must be in
`config.yaml` -- and ingest restarted, so the upsert actually runs -- BEFORE
that node's PSK first goes live and it starts sending real traffic. A role
correction made *after* CSI has already been captured under the wrong role
does not un-compute anything: nothing in this system recomputes history by
itself, so every row already derived from that window stays derived from
box-rig hand-waving until a person removes it.

**And if it already happened, "delete the `features`/`occupancy_states`
rows" is not a sufficient recovery.** Correcting `config.yaml` only stops
new records from crossing the fence; two pieces of state survive that
deletion and keep the poison in circulation. The clean-up is manual and
deliberately not scripted, and the order below is load-bearing -- each step
reads state an earlier one fixes:

1. **Fix `role: box` in `config.yaml` and restart ingest -- first, before
   deleting anything.** `nodes.role` is rewritten from that file on every
   ingest start (`packages/ingest`'s startup upsert) *and* at the start of
   every `homecsi replay` (`@homecsi/storage`'s `replayCaptures` upserts
   every `config.nodes` entry before it writes a row), with `role`
   defaulting to `'house'` when the field is absent -- so a hand-written
   `UPDATE nodes SET role = 'box'` without the config change is silently
   reverted by the next restart or replay. Everything below reads
   `nodes.role` at the moment it runs.
2. **Delete that node's `features` rows** -- scoped to its `node_id` and
   the window, not to the window across all nodes. Other nodes' rows in
   that window are honest house observations, and each `features` row also
   carries the adaptive baseline state its link resumes from. This is also
   the step that makes step 1's ordering matter: `@homecsi/features` has no
   checkpoint table -- it resumes each link from that link's newest
   surviving `features` row (`packages/features/src/pipeline.ts`) -- so
   deleting rows that are a link's *most recent* ones (which they will be,
   if this is caught soon) moves that link's resume point back to before
   the deleted window, and the next `features` run recomputes it straight
   out of `csi_records`, re-poisoning the table if the role is still wrong.
   Expect friction from the delete itself: `features` chunks older than a
   day are compressed (migration 007), which is precisely the row-level
   surgery that migration's own comment argues against doing to this table.
3. **Delete the affected `occupancy_states` rows AND rewind or delete
   `occupancy_checkpoint`.** Skipping the second half is what makes the
   whole exercise futile. `occupancy_checkpoint` (migration 006) is a
   singleton row carrying `latch_state`, the read cursor `last_tick_ms`,
   and the change detector's `last_written_tick_ms`/`last_estimate`/
   `last_state` forward across runs; deleting historical rows leaves it
   untouched, so a latch left `OCCUPIED` by a hand near a box goes on
   driving every row written afterwards, and the cursor -- which only moves
   forward -- means nothing in the deleted window is ever recomputed, just
   missing. `server/packages/occupancy/README.md` ("Decision: replay is
   features-only") is the authority on this operation and on why there is
   no CLI command for it.
4. **Check `training_features` (migration 007).** If a *manual* label
   session was open across the poisoned window, session-stop (or a later
   `label preserve` sweep) has already copied those `features` rows into a
   separate plain table that no retention policy touches, and both `label
   export` and `homecsi train` read `features` UNIONed with
   `training_features` -- so a poisoned feature vector survives step 2
   entirely and keeps feeding the training corpus. It has the same
   `(time, node_id, link_mac)` identity, so scope the delete the same way.
   Anything already exported to a file, or trained from such an export, is
   downstream of the database and out of reach of any of this.
5. **Only then re-run `features`/`occupancy`** -- and re-run `homecsi box
   preserve` for any take recorded during that window. While the node read
   as `role = 'house'` it was excluded from `@homecsi/box`'s own
   `role = 'box'` preservation query *and* from the count of registered box
   nodes the partial-dropout check compares against, so the take was
   preserved quietly missing that node's vantage point rather than warning
   about it. Re-preserving is idempotent, but only reaches records still
   inside the 7-day `csi_records` window -- and even then those records
   were rate-limited like a house node's while they were captured (ingest
   bypasses the persisted-rate ceiling only for `role = 'box'` nodes), so
   what comes back is a thinner take than a correctly-roled one. Re-record
   the gesture if it matters.

Note that `homecsi replay` is not a recovery step here and cannot become
one: it re-derives raw rows only (`csi_records`/`heartbeats`, idempotently
-- migration 004's unique index plus `ON CONFLICT DO NOTHING`), never
`features` or `occupancy_states`. Run against a still-wrong `config.yaml`
it actively re-poisons, because of the role upsert in step 1. See
`docs/deployment.md`'s node-registration section for the matching
operational checklist -- not duplicated here.

## What this hardware can and cannot resolve

Same radios as the house mesh: **802.11n, 2.4 GHz, single antenna (SISO),
no MIMO.** At 2.4 GHz, wavelength λ ≈ 12.5cm. Being honest about what that
buys, in order of how defensible each claim is:

- **A hand present in/near the box, versus an empty box** -- realistic. A
  hand at ~30cm range perturbs multipath enough for amplitude-based motion
  features to show a clear signal against a quiet baseline.
- **Coarse motion versus stillness** (waving fingers vs. holding a fist
  still) -- realistic, same underlying signal the whole-house motion
  detection already relies on, just at much shorter range and much higher
  signal-to-noise for that reason alone.
- **A handful of coarse, deliberately distinct hand shapes** (fist vs. flat
  palm vs. spread fingers) -- plausible as a fun result, not guaranteed.
  This is the actual thing this experiment is trying to find out.
- **Separated fingers as an independently resolvable feature** -- out of
  reach. A single SISO antenna with no angle-of-arrival information cannot
  resolve sub-wavelength spatial detail; five separate nodes each doing
  their own single-antenna capture do not combine into a synthetic-aperture
  or MIMO-like spatial resolution just by being in different places
  (`docs/architecture.md` "Node placement and zone attribution" makes the
  identical point about node coordinates: they are for geometry/drawing,
  never for localisation, because phase has no hardware TX/RX lock or
  CFO/SFO correction -- see "Amplitude-first" below).
- **Identifying a specific person from their hand** -- at or past the limit
  of this hardware. If a `box train` report ever comes back only barely
  above the random-chance baseline this doc requires it to always report
  alongside accuracy, **that is the honest, expected result for a
  hard-to-resolve class distinction, not a bug** -- it would be a fun
  result (this hardware can *just barely* tell two people's grips apart!),
  not a finding to build anything on.

No angle-of-arrival is available from any single node, and never will be
without a hardware upgrade this project isn't undertaking: amplitude-first
still applies (see `docs/architecture.md`) -- CSI phase here has no
hardware TX/RX phase lock and is not corrected for CFO/SFO, so nothing in
this experiment, any more than the house-occupancy pipeline, may depend on
phase being meaningful.

## Baseline drift: "hand present but still" only works against a recent calibration

A gesture with real hand motion (fingers waving, a fist closing) produces
its own motion signal almost regardless of baseline age -- motion energy is
large relative to a quiet channel however that channel drifted. But "hand
present, held still" is a much smaller, baseline-relative deviation, and it
degrades exactly the way `docs/architecture.md`'s adaptive baseline exists
to handle for the whole house: an empty-box calibration goes stale with
temperature drift, and it goes stale immediately, completely, and
non-recoverably if the box itself is physically moved (a new position
changes every multipath geometry the calibration was measuring). Record an
empty-box "control" take reasonably close in time to the takes it's meant
to contextualise, and re-calibrate after moving the box -- the same
operational discipline `docs/architecture.md`'s adaptive EMA baseline
exists to reduce (not eliminate) the need for on the house side.

## Take semantics

Gestures are sub-second and the five box nodes are not time-synchronised
with each other, so a take's window is defined explicitly rather than
improvised per call site (`@homecsi/box`'s `takeWindow.ts`):

- **A take's window is `[started_at, ended_at)` on server receive time** --
  the same clock every `csi_records.time` value already uses. No cross-node
  clock alignment is attempted or needed.
- **A configurable lead-in/lead-out trim** (`DEFAULT_LEAD_TRIM_MS`, 200ms
  each side by default) is applied when selecting a take's records, so the
  operator's hand physically entering/leaving the box at the start and end
  of a hold isn't captured as if it were the gesture itself.
- **A take needs a minimum number of preserved records to be usable**
  (`DEFAULT_MIN_TAKE_RECORDS`) -- a handful of stray rows is noise, not a
  recorded gesture, and is excluded from training/export rather than
  silently included as a nearly-empty example.
- **A partial node dropout is a warning, not a lost take.** Preservation
  compares the number of DISTINCT nodes that actually reported CSI for a
  take's window against the number of currently-registered `role = 'box'`
  nodes. If some, but not all, of the registered nodes reported -- a node
  powered off, a firmware fault, a UDP loss burst hitting most links but
  not all -- the take is still preserved, but `POST /api/box/sessions/:id/
  stop`'s `preservationWarning` and the `box preserve` sweep's output both
  name the shortfall explicitly ("only N of M registered box nodes
  reported"). Seeing this warning usually means a node dropped during that
  specific take, not that the take is worthless -- decide per-gesture
  whether the missing vantage point matters enough to re-record. Only
  *total* loss (zero rows from any node, anywhere) is a hard preservation
  error; this is deliberately a lower bar than that, so a routine bench-rig
  hiccup doesn't become an alarm the operator learns to ignore.

## Why takes preserve raw CSI, not computed features

`training_features` (migration 007, `@homecsi/labeling`) preserves an
already-*computed* feature vector, because the whole-house feature set is
stable and shared across the entire pipeline. The box experiment is the
opposite case on purpose: **feature iteration is the entire point of a
recreational ML experiment.** Freezing to one feature set at capture time
would make every past take permanently unusable the moment the operator
wants to try a different feature (a different subcarrier selection, a
different windowing choice, a feature this doc's author didn't think of
yet). `box_take_records` (migration 012) therefore preserves the raw
`csi_data` bytes, `rssi`, and `csi_format` for every record in a take's
trimmed window, and `@homecsi/box` computes features from those raw
records at **train** time, reusing `@homecsi/features`' own
`parseCsiAmplitudes`/`computeWindowFeature` -- amplitude-first, and never
assuming a fixed subcarrier count, same as the rest of this system (CSI
record layout is `csi_format`-dependent; every consumer of raw CSI bytes
parses by the record's own `csi_len`, not a hardcoded size).

A take is copied out of `csi_records` into `box_take_records` before
migration 007's 7-day debug-window retention policy drops the source rows
-- preservation happens at session-stop time (CLI and API both), with
`homecsi box preserve` as the standing backstop sweep for takes the
stop-time hook missed (mirrors `label preserve` exactly). Preservation
fails loudly (not silently) if a take's window shows zero rows anywhere,
and an already-preserved take whose live `csi_records` rows have since aged
out still reads as found, not lost -- see `@homecsi/box`'s
`preservation.ts` for the exact discipline, deliberately simpler than
`@homecsi/labeling`'s baseline-relative density check: that check exists
because `features` is a continuous always-on stream with a meaningful
"recent live density" to compare against, while box nodes are silent
outside a take (they only bypass the ingest rate ceiling while a
`box_sessions` row is open), so there is no continuous baseline to build a
density floor from here.

## Realtime mode and airtime

While a `box_sessions` row is open, ingest bypasses its persisted-rate
ceiling for box-role nodes so a take's dense CSI actually lands in
`csi_records` -- **outside a take, the persisted stream for box nodes is
decimated by design**, same rate-limiting the house mesh gets normally.
The full-rate burst only ever exists (briefly) in `csi_records` during an
open take, and then in `box_take_records` once preserved; it is never the
steady-state persisted rate for these nodes.

Box nodes are not a separate radio -- they share the **one fixed 2.4 GHz
channel** with the house mesh (`docs/architecture.md` "Radio design": one
channel, deliberately, because these ESP32s cannot channel-hop without
fragmenting the motion signal). A box take's dense burst therefore consumes
real airtime on that shared channel, and **the house mesh nodes' own CSI
cadence may visibly jitter while a take is being recorded.** This is a real,
bounded cost, not a hidden one: it lasts only as long as a take is open
(a few seconds by design -- gestures are sub-second, holds are short), and
resumes the house mesh's normal cadence the moment the take is stopped.
Recording many takes back-to-back for an extended session will produce a
visibly jittery house-side motion signal for that whole session; this is
expected, not a bug to chase, and is a reasonable trade to make deliberately
(not accidentally) when running this experiment.
