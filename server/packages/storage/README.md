# @homecsi/storage

Owned by brief B3 (ingest/storage). Implements raw-capture writing,
replay, and the rotation/retention/compression lifecycle described in
`docs/architecture.md`. See `server/packages/cli/CONTRACTS.md` for this
package's exact exported function contracts (`replayCaptures`,
`pruneStorage`).

See `FORMAT.md` for the on-disk raw-capture shard format.

## Public exports

Beyond the two CLI-contracted functions, this package also exports:

- `CaptureWriter` — appends accepted/decrypted datagrams to rotating
  shard files; used by `@homecsi/ingest`.
- `DbWriteQueue` — the bounded, batched database-write path shared by
  live ingest and `replayCaptures`, so the two are never divergent code
  paths. See its doc comment (`src/dbWriter.ts`) for the queue-overflow
  and batch-failure policies and their rationale.
- `readShardRecords`, `listClosedShardFiles`, `compressAgedShards`,
  `resolveCaptureDir` — building blocks reused internally by
  `replayCaptures`/`pruneStorage` and exposed for tests/tooling.

## Known limitations (flagged, not fixed here)

- `resolveCaptureDir` resolves `config.storage.captureDir` relative to
  `process.cwd()`, since this package only ever receives an
  already-parsed `Config`, never the config file's own path.
  `packages/cli`'s `doctor` resolves the same value relative to the
  config file's directory instead. These agree whenever commands are run
  from the same working directory the config file lives in (the common
  case), but can diverge otherwise. See `src/paths.ts`.
## Replay is idempotent

Migration 004 added `boot_epoch`/`seq` (plus `record_index` on
`csi_records`, since one wire datagram carries multiple CSI records) and
a unique index on both tables covering the wire datagram's identity.
`DbWriteQueue`'s inserts use `ON CONFLICT (...) DO NOTHING` against those
columns, so `replayCaptures` can safely be re-run, or run over a range
that overlaps already-ingested live data, without producing duplicate
rows. See `src/dbWriter.ts` for the exact key columns and `src/replay.ts`
for the full behaviour.
