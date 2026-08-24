# Device API (OTA manifest + firmware delivery)

This document specifies the HTTP contract between an ESP32 node and the
server's device-facing surface: how a node authenticates, how it reports
telemetry, and how it discovers and fetches a staged firmware update. It is
**not** part of the UDP wire protocol -- `docs/protocol.md` and
`server/packages/protocol` remain the only two places that contract lives,
per `CLAUDE.md`. This is a second, independent, plain-HTTP contract, executed
by `server/packages/api`'s device routes on one side and the ESP32 firmware's
OTA client on the other (brief B3).

`docs/protocol.md` section 8 reserves `msg_type = 4` (`OTA_STATUS`) for a
UDP-carried firmware-status report and explicitly marks it unimplemented --
that reservation stands unchanged. Node status (firmware version, boot
epoch, uptime, OTA state) ships over **this** HTTP surface instead, via
`POST /device/hello`, not over UDP. `OTA_STATUS` remains reserved and
unimplemented.

## Two separate auth realms

The server's HTTP surface has two independent bearer-token realms that never
grant access to each other's routes:

| Realm | Routes | Token | Enforced by |
| ----- | ------ | ----- | ----------- |
| Dashboard | `/api/*` (except `/api/ws`, which auths via its own first-message protocol) | `config.server.apiToken`, one shared value | `onRequest` hook in `server.ts` |
| Device | `/device/*` | Per-node device token, derived from that node's own `psk` | A second, separate `onRequest` hook in `server.ts` |

`GET /api/devices` is the one exception worth calling out explicitly: it
exposes device state (see below) but lives under `/api/`, so it requires the
**dashboard** token, not a device token -- that's what lets a human operator
watch a staged rollout progress.

A request presenting a valid token for the wrong realm is rejected with
`401`, the same as no token at all. Each hook only inspects requests whose
path falls under its own prefix; a device token is never checked against
`apiToken`, and `apiToken` is never checked against the device-token
registry.

## Device credential

Every node already has a unique 32-byte pre-shared key at
`config.nodes[].psk` (base64-encoded), used today for UDP datagram sealing
(`docs/protocol.md` section 5). The device HTTP token is derived from that
same PSK, so nothing new needs to be provisioned or flashed:

```
device_token = base64url_nopad( HMAC-SHA256(key = psk_raw_32_bytes, msg = "homecsi-device-v1") )
```

- The HMAC key is the PSK's raw **32 decoded bytes** -- never its base64
  string.
- The message is the fixed ASCII literal `homecsi-device-v1`, no trailing
  newline. It exists to domain-separate this derivation from any other use
  of the same PSK; it is not a secret.
- The output is base64url (`-`/`_` in place of `+`/`/`), with padding
  omitted, per RFC 4648 -- a 32-byte SHA-256 HMAC digest encodes to exactly
  43 characters this way.

A node sends its token as a normal bearer credential:

```
Authorization: Bearer <device_token>
```

### Golden vector

Independently reproduced by both sides (`server/packages/api/src/deviceAuth.test.ts`
and the firmware's own host test, brief B3) -- neither side computes this
expectation with its own implementation; both hardcode it, so a passing test
on both sides is what actually proves the two implementations agree, not
that either agrees with itself:

```
psk (base64) = AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=      (= bytes 0x00..0x1f)
label        = homecsi-device-v1
HMAC hex     = be7645fc0b07db5d069ef99a6337f3a1a97beba5d28fde084fae65e31c189b5f
device_token = vnZF_AsH210GnvmaYzfzoal766XSj94IT65l4xwYm18
```

### Startup safety: no two nodes may share a token

The server builds a token → node-id registry once at startup from
`config.nodes`. If two configured nodes derive the same device token -- which
can only happen if they were (accidentally or otherwise) given the same
`psk` -- the server refuses to start, naming both offending node ids.
`firmware/tools/provision.py` already prevents this by construction when
generating PSKs, but a hand-edited `config.yaml` has no such guarantee, and a
shared PSK is catastrophic under this protocol's nonce construction
(`docs/protocol.md` section 4) regardless of which transport carries it.

## Routes

All device routes live under `/device/` and require a valid device bearer
token. On success, the server resolves the token to a node id internally;
none of the request bodies below need to (or do) repeat which node is
calling.

### `POST /device/hello`

Pure telemetry. A node calls this periodically (or on boot / on OTA
state change) to report its current status.

Request body:

```json
{
  "fwVersion": "0.2.0",
  "bootEpoch": 3,
  "uptimeS": 4821,
  "otaState": "idle"
}
```

Response: `200 { "ok": true }`.

The server records the reported fields plus a server-side last-seen
timestamp **in memory only**, keyed by the resolved node id. There is no
database write and no migration backing this -- a process restart simply
means the next `hello` re-populates the in-memory record; this is an
accepted, intended gap, not a bug. `otaState` is an opaque string as far as
the server is concerned; it is surfaced to operators verbatim via
`GET /api/devices`, not interpreted.

### `GET /device/ota/manifest`

Returns the currently staged manifest, if any, and if the calling node is
part of its rollout:

- `200` with the manifest's client-relevant fields, if a valid
  `manifest.json` exists (see below) and the calling node is in `rollout`:

  ```json
  { "version": "0.2.0", "sizeBytes": 1048576, "sha256": "<64 lowercase hex chars>" }
  ```

  `sizeBytes` is the actual on-disk size of the image file the manifest
  names, not a value read from the manifest -- it always reflects reality.
  `sha256` is passed through from the manifest as-is.

- `204` (no body) in every other case: no `manifest.json` present, the file
  is malformed or fails validation, or the calling node is not in `rollout`.
  A `204` deliberately carries no information about *which* of those is
  true -- from the node's point of view, "nothing to offer right now" is
  the only distinction that matters.

**The server never compares the node's running firmware version against the
manifest.** This route takes no "current version" input at all, and never
will: filtering is on `rollout` membership only. This is deliberate, not an
oversight -- the server's only knowledge of what a node is currently running
comes from `POST /device/hello`, which is in-memory and empty immediately
after a server restart, i.e. wrong exactly when a staged rollout is most
likely to be in progress. The **node** compares `manifest.version` against
its own running version and against the version in its known-bad OTA slot,
and decides for itself whether to fetch. The server's only job is deciding
who is *allowed* to see the manifest at all (`rollout`), never whether the
update is *needed*.

### `GET /device/ota/firmware`

Streams the firmware image itself as `Content-Type: application/octet-stream`
when a valid manifest exists and the calling node is in `rollout`; `404`
(no body) otherwise -- including when the manifest is missing/malformed, the
node is not in rollout, or `manifest.file` fails the path-safety check
below. As with the manifest route, a `404` does not distinguish between
these cases.

## The OTA artifact directory

A directory on disk (`config.ota.firmwareDir`, default `/data/firmware` --
the in-container data path) containing exactly one `manifest.json` plus the
image file(s) it names:

```json
{
  "version": "0.2.0",
  "file": "homecsi-node-0.2.0.bin",
  "sha256": "3b1d6f...<64 lowercase hex chars total>",
  "rollout": "all"
}
```

- `version`: an opaque string, non-empty. The server never parses or
  compares it (see above) -- it exists purely for the node to reason about
  and for `GET /api/devices` to display alongside reported `fwVersion`.
- `file`: the image filename, resolved against `firmwareDir` (see path
  safety below).
- `sha256`: 64 lowercase hex characters, passed through verbatim in the
  manifest response. Not verified against the actual file by the server --
  the node is expected to verify it after downloading.
- `rollout`: either the literal string `"all"`, or an array of node ids
  (e.g. `[1, 3]`) -- the staged-rollout mechanism from `docs/roadmap.md`'s
  OTA section, implemented here with one JSON field and no database, no
  migration, and no extra service.

An operator stages a rollout by writing a new `manifest.json` (and the
matching image file) into `firmwareDir`. **No server restart is required**:
both `/device/ota/manifest` and `/device/ota/firmware` read `manifest.json`
from disk on every request rather than caching it, specifically so a new
rollout takes effect immediately.

A missing or malformed `manifest.json` (invalid JSON, or JSON that fails
schema validation -- wrong types, missing fields, a `sha256` that isn't 64
lowercase hex characters, etc.) is treated as "nothing staged": `204` from
the manifest route, `404` from the firmware route. It is never a `500` and
never an unhandled exception -- an operator's mistake while staging a
rollout must not be able to crash or wedge the server process.

### Path safety

`manifest.file` is written by an operator, not by the server, and is
therefore untrusted input crossing a trust boundary (reading arbitrary
files from disk on request). The server resolves it against `firmwareDir`
and accepts it **only** if the result is a direct child of `firmwareDir` --
rejecting:

- a `..` escape (e.g. `../../etc/passwd`),
- an absolute path (e.g. `/etc/passwd`, or an absolute Windows path),
- a nested path (e.g. `subdir/image.bin`) -- even one that would technically
  still resolve inside `firmwareDir`.

Anything rejected by this check is treated exactly like a missing file:
`204`/`404`, plus a warning logged server-side naming the offending
`manifest.file` value (never served, never read).

## Config

```yaml
ota:
  firmwareDir: "../data/firmware"
```

Optional, like `training` in the same file, and for the same reason: it was
added after the rest of the schema, and there is a safe built-in default
(`/data/firmware`) for when it's omitted, so omitting the whole section is
not a startup error. Overridable via `HOMECSI_OTA_FIRMWARE_DIR`
(`server/packages/config/src/env.ts`).
