# @homecsi/ingest

Owned by brief B3 (ingest/storage). Implements the UDP ingest server that
receives node datagrams, decodes them with `@homecsi/protocol`, and writes
them to raw capture files and TimescaleDB. See
`server/packages/cli/CONTRACTS.md` for this package's exact exported
function contract.

## Metrics

`getIngestMetrics()` (see `src/index.ts`) returns a plain, JSON-serializable
`IngestMetrics` snapshot (datagrams received/accepted/rejected-by-reason,
queue depth/drops, records written, batch insert failures, per-node
last-seen/last-seq). See that function's doc comment for a same-process
caveat relevant to brief B5.

## Testing

`src/engine.test.ts` exercises `createIngestEngine` directly (no real UDP
socket, no real database, no real disk) with a fake `CaptureWriterLike`/
`DbWriteQueueLike`, covering the round-trip and hostile-input cases listed
in the B3 brief.
