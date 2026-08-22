# Home CSI raw-capture format

This document describes the on-disk format `@homecsi/storage`'s
`CaptureWriter` produces and `readShardRecords`/`replayCaptures` consume.
It is the disaster-recovery / reprocessing log described in
`docs/architecture.md` ("Data lifecycle") — every datagram that ingest
accepts (decrypted, replay-window-checked) is appended here before (or
independently of) any database write, so the raw signal survives even a
schema bug or a lost database.

## Directory layout

A flat directory (`config.storage.captureDir`) of shard files. No
per-node or per-date subdirectories — this keeps `packages/cli`'s
`doctor` command's plain recursive directory-size sum a valid disk-usage
calculation (see that command's own note about this assumption).

## Shard filenames

```
capture-<startMs>-<counter>.hcscap           finalized (closed), uncompressed
capture-<startMs>-<counter>.hcscap.gz        finalized, gzip-compressed
capture-<startMs>-<counter>.hcscap.writing   currently being appended to
```

- `startMs`: `Date.now()` at the moment the shard was opened.
- `counter`: a per-process monotonically increasing rotation counter,
  used only to break ties if two shards would otherwise open in the same
  millisecond; zero-padded to 6 digits so filenames still sort correctly
  as plain strings.
- Sorting shard filenames lexicographically is equivalent to sorting by
  `(startMs, counter)` ascending, i.e. "timestamp order" as required by
  `replayCaptures`.

**The `.writing` suffix is the concurrency-safety mechanism** for this
whole package: it is present if and only if a shard might still be
appended to. `pruneStorage`, `compressAgedShards`, and directory-mode
`replayCaptures` all only ever consider `.hcscap`/`.hcscap.gz` files —
never `.hcscap.writing` — so they are safe to run at any time, including
concurrently with a live `runIngest` process, with no locks or IPC of any
kind. `CaptureWriter` finalizes (renames away the `.writing` suffix) a
shard the instant it stops being the active one (on rotation or on
`close()`); if the process is killed instead, the `.writing` file is
picked up and finalized the next time a `CaptureWriter` is constructed
and `init()` is called (e.g. the next `runIngest` start).

## Shard file contents

```
[8-byte magic "HCSCAP01"]
[record][record][record]...[possibly one incomplete/truncated record]
```

The magic bytes identify the file as a Home CSI capture shard and pin
this framing format's version (bump to e.g. `HCSCAP02` if the record
layout below ever changes incompatibly).

### Record framing

```
u32 LE   bodyLen           length of everything below, in bytes
u64 LE   receivedAtMs      Date.now() when ingest accepted this datagram
u16 LE   nodeId
u32 LE   bootEpoch
u32 LE   seq
u8       msgType           1 = CSI_BATCH, 2 = HEARTBEAT (mirrors the wire protocol's MsgType)
bytes    payload           bodyLen - 19 bytes: the plaintext CSI_BATCH or
                            HEARTBEAT payload exactly as produced by
                            @homecsi/protocol's encodeCsiBatch/encodeHeartbeat
```

`(nodeId, bootEpoch, seq)` is the same datagram identity tuple from
`docs/protocol.md` section 3/6 — stored so a capture record can be
correlated back to exactly which wire datagram it came from.
`receivedAtMs` is this server's own wall clock, always trustworthy
(unlike a node's possibly-SNTP-unsynced `wall_clock_us`).

**Why length-prefixed and not checksummed:** a reader only ever needs to
answer "is this record complete?", and a length prefix answers that
directly — if the declared `bodyLen` runs past the end of the currently
available bytes, the reader stops there and returns everything decoded
so far, without throwing. This is what makes a truncated final record —
the expected outcome of `SIGKILL`ing ingest mid-append, or of reading a
shard while ingest is still appending to it — harmless to the rest of the
shard: `readShardRecords` yields every complete record before the
truncated one and then simply ends.

**What this does and does not protect against.** A length prefix alone
only detects a torn final record at the point the reader's available
bytes actually run out — end-of-stream truncation. It cannot, by itself,
detect a *mid-file* tear: bytes that went missing partway through the
file, immediately followed by more (valid-looking) record bytes written
after the tear. If that happened, a stale-but-well-formed length prefix
could be satisfied by bytes that actually belong to a different record,
silently producing a wrong record rather than merely dropping one.

This class of corruption is prevented on the **write** side, not detected
on the read side: `CaptureWriter` checks the `bytesWritten` result of
every `write()` call, and treats anything less than a full write as fatal
for the shard currently open — it immediately stops writing to that file
(closing and finalizing it with its valid prefix intact) and opens a
fresh shard for the next append, rather than ever writing a subsequent
record's bytes after a torn one in the same file. Combined with the
length-prefix behaviour above, every shard `readShardRecords` is ever
asked to read is therefore either fully well-formed, or well-formed up to
a single truncated tail at end-of-file — never a tear followed by more
data in the same file. See `captureWriter.test.ts`'s short-write test for
the regression this guards against, and `captureFormat.ts` for the parser
side.

This still assumes the underlying storage does not silently corrupt
already-written bytes after the fact (bit rot, a failing disk, someone
manually editing the file) — that class of corruption is out of scope for
this format, which is designed around actual observed failure modes
(process kill, short writes) rather than arbitrary bit-level corruption.

### Compression

A closed (`.hcscap`) shard older than `config.storage.compression.afterMs`
(measured from its last-modified time, i.e. when it was finalized) is
gzipped in place (`compressAgedShards`, driven by `pruneStorage`) using
Node's built-in `zlib`. `readShardRecords` transparently decompresses any
`.gz` shard via `zlib.createGunzip()` before parsing — replay code never
needs to know or care whether a given shard is compressed.

## Replay semantics

`replayCaptures(inputPath, config)`:

- Resolves `inputPath` relative to `process.cwd()`.
- A directory is expanded to every finalized shard inside it
  (`.hcscap`/`.hcscap.gz`, in timestamp order); a single file is read
  directly regardless of extension.
- **Writes decoded rows to the configured database**, using the exact
  same `DbWriteQueue` batched-insert path live ingest uses — not a
  separate, potentially-divergent implementation.
- Does **not** re-run AEAD or the wire protocol's per-node
  `ReplayWindow` check (capture records are already-decrypted,
  already-accepted plaintext by construction), and does **not**
  re-append to the capture files it reads from.
- **Is idempotent** against rows already present from a prior live-ingest
  run or prior replay of the same range (migration 004):
  `csi_records`/`heartbeats` have unique indexes on the wire datagram's
  identity (`node_id`, `boot_epoch`, `seq`, plus `record_index` for
  `csi_records` since one datagram carries multiple CSI records, plus
  `time` because TimescaleDB requires the partitioning column in any
  unique index — `time` is derived deterministically from each record's
  own fields, so this doesn't weaken the guarantee), and `DbWriteQueue`'s
  inserts use `ON CONFLICT (...) DO NOTHING` against exactly those
  columns. Replaying an already-ingested range is therefore safe and
  produces no duplicate rows — see `src/replay.ts`'s doc comment and
  `src/dbWriter.ts` for the exact key columns.
