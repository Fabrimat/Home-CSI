# @homecsi/api

Owned by brief B5 (api/web). Implements the token-authenticated HTTP API
serving occupancy state/history and the built `@homecsi/web` UI. See
`server/packages/cli/CONTRACTS.md` for this package's exact exported
function contract (`startServer`).

## `/api/occupancy` is a sparse event log, read with step semantics

`occupancy_states` holds one row per state *transition* plus a keepalive
every 15 minutes of tick time — not one row per 500 ms window (see
`packages/occupancy/README.md`). Three consequences for API consumers:

- The response includes a **carry-in** event: the last row at or before
  `from`, at its real (pre-window) timestamp, so `states[0].time` can be
  earlier than `from`. Carry each value forward to the next row; a window
  with no events inside it is not an empty window.
- `limit` bounds **events, not samples**. Trimming now drops transitions,
  so narrow the range instead of leaning on the limit. The carry-in is
  always kept; the oldest in-window events are dropped first.
- `kind` is `"transition"` or `"keepalive"`. A gap with no keepalive means
  there were no whole-house observations at all — real information, not
  missing data.

Over WebSocket, a new `occupancy` subscriber receives a one-time
`{"type":"data", …, "snapshot":true}` message carrying the latest row
(whatever its age) on the first poll tick, because a sparse log may have
nothing new to send for a long time.

## Labels: intervals and explicit provenance (migration 008)

`labels` rows can now describe a **time interval**, not just a point:
`endTime` (ISO-8601, **exclusive**) is `null` for a point label (unchanged
pre-migration-008 behaviour) or a real end for an interval. Every label
also carries an explicit `source`: `'manual'`, `'weak:phone-presence'`,
`'confirmed'`, or `'training'` (the values `labels.source`'s CHECK
constraint admits) — the authoritative way to ask "how was this label
produced", superseding (without replacing) the `WEAK_LABEL_PREFIX`
notes-string convention `@homecsi/labeling` still writes alongside it.

- **`GET /api/labels?from=ISO&to=ISO&limit=N`** — labels across **all**
  sessions whose interval *overlaps* `[from, to)`
  (`time < to AND COALESCE(end_time, time) >= from`), so the dashboard can
  show existing corrections on the timeline before picking a session. This
  is an overlap predicate, not containment: a label that started before
  `from` and ends inside the window is included.
- **`GET /api/labels/sessions/:sessionId/labels?limit=N`** — unchanged
  behaviour, rows now carry `endTime`/`source`.
- **`POST /api/labels`** — body gains optional `endTime` (400 if
  `endTime <= time`) and `source` (defaults to `'manual'`).
- **`PATCH /api/labels/:labelId`** — updates only `end_time` (body:
  `{ endTime }`). Used by the training-mode guided walk (brief B14) to
  close a previously-open declaration when the operator declares the next
  state. 404 if the label doesn't exist, 400 if `endTime` is not after the
  label's own `time`. Nothing else about a label is ever updatable.
- **`POST /api/labels/corrections`** — the dashboard's core feedback-loop
  action: one composite, server-side operation that (a) creates a
  `label_sessions` row starting at `from`, (b) inserts the interval label
  (`time = from`, `end_time = to`), (c) stops that session at `to`, and
  (d) attempts training-set preservation for it — in that order. This does
  NOT run inside a single DB transaction, so a failure between (a) and (c)
  can still leave a dangling open "dashboard correction" session — what
  collapsing three client round-trips into one server call actually
  eliminates is the *client-abandonment* failure mode; a genuine mid-request
  DB failure still leaves an ordinary open session, which the `label
  preserve` sweep's open-session retention warning already surfaces. 400s
  (before writing anything) if `to <= from` or if the span exceeds
  `config.storage.retention.maxAgeMs` — a correction longer than the whole
  debug window can never have its raw per-link features preserved. Mirrors
  `POST /api/labels/sessions/:sessionId/stop`'s preservation failure
  semantics exactly: a preservation failure still returns `201` with the
  created `session`/`label`, plus a `preservationWarning` string, never a
  `500` or a rollback.

  **Why a session per correction, not one long-running "dashboard
  corrections" session:** `preserveSessionFeatures` is keyed on a
  session's window (`started_at..ended_at`). A per-correction session
  makes that window exactly the corrected interval; a single session
  reused by every correction ever made would instead grow without bound
  until it converged on the entire `features` table — the same unbounded
  "labelled covers practically all of `features`" ballooning
  docs/architecture.md and docs/roadmap.md warn about for the always-on
  weak-label cron. See the route's own comment in `routes/labels.ts` for
  the full reasoning.

## `GET /api/config`

Exposes the client-relevant slice of server config the dashboard needs to
reason about retention deadlines (docs/roadmap.md "Web dashboard" — "The
7-day deadline: a real UX constraint"): `retentionMaxAgeMs`
(`config.storage.retention.maxAgeMs`) and `retentionSafetyMarginMs`
(`@homecsi/labeling`'s `DEFAULT_RETENTION_SAFETY_MARGIN_MS`, the same
margin the CLI's own retention warnings already use). Deliberately narrow
— not the whole `Config` object — since nothing else in `Config` is safe
or useful to hand to a browser client.
