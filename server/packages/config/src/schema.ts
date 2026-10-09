import { z } from 'zod';

const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const serverSchema = z.object({
  udp: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
  }),
  http: z.object({
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535),
  }),
  apiToken: z.string().min(16, 'apiToken must be at least 16 characters'),
});

const databaseSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  ssl: z.coerce.boolean().default(false),
  pool: z.object({
    min: z.coerce.number().int().nonnegative(),
    max: z.coerce.number().int().positive(),
  }),
});

const base64Psk = z
  .string()
  .refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'psk must be base64-encoded and decode to exactly 32 bytes' },
  );

const macAddressSchema = z
  .string()
  .regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/, 'invalid MAC address');

// {x, y} in METRES, relative to an arbitrary origin the operator picks --
// there is exactly one origin per FLOOR (e.g. a corner of that floor's own
// plan, or one particular node on it), never one shared origin across the
// whole house. These coordinates exist for geometry and drawing ONLY:
// deriving a link's endpoints/midpoint/length/rooms-spanned for
// GET /api/topology (@homecsi/api), and letting the dashboard draw a floor
// plan. They must NEVER be used to trilaterate or otherwise estimate a
// person's position -- ESP32 CSI phase has no hardware TX/RX lock and is
// not corrected for CFO/SFO (docs/architecture.md "Amplitude-first"), so
// this system cannot localise anything more precise than "which link
// showed motion".
const positionSchema = z.object({
  x: z.coerce.number(),
  y: z.coerce.number(),
});

// A DATA-FLOW FENCE, not a label. `role` decides which pipeline a node's
// CSI is allowed to reach, nothing more -- brief B1's box-experiment nodes
// (5 ESP32-C6s wired around a closed box for hand-presence/gesture work,
// docs/architecture.md is silent on this by design: it is deliberately NOT
// part of the house occupancy story) talk to the SAME ingest as house
// nodes, so without this field their CSI would flow straight into
// @homecsi/features's record query and from there into the latched
// occupancy state machine -- a hand waved in the box would permanently
// (occupancy_states has no retention policy) latch the house to
// "occupied". `@homecsi/features`'s pipeline query (pipeline.ts's
// `createPgCsiRecordSource`) joins against this column and keeps only
// `'house'` rows; that one choke point is the actual fence (occupancy
// reads `features`, so fencing there fences both stages) -- this schema
// field only decides which side of it a node's rows land on. Defaults to
// `'house'` so every pre-existing deployment (and every node an operator
// forgets to annotate) is fenced-in, never silently fenced-out.
const nodeRoleSchema = z.enum(['house', 'box']).default('house');

const nodeSchema = z.object({
  id: z.coerce.number().int().min(1).max(65535),
  name: z.string().min(1),
  room: z.string().min(1),
  psk: base64Psk,
  expectedMac: macAddressSchema.optional(),
  // Signed floor index -- a basement/garage below the operator's own
  // "ground floor" can be -1, -2, etc. Defaults to 0 so a single-floor (or
  // not-yet-placed) deployment never needs to think about this. Purely a
  // grouping/drawing key on its own; `position` below is what makes it
  // geometric.
  floor: z.coerce.number().int().default(0),
  // Optional: a working deployment that hasn't measured anything yet must
  // still validate. Omitted means "not placed yet" (don't draw this node),
  // never "at (0, 0)" -- see positionSchema's comment for the full
  // units/origin/no-trilateration contract.
  position: positionSchema.optional(),
  // See nodeRoleSchema's own comment immediately above -- this is a
  // data-flow fence, not a label.
  role: nodeRoleSchema,
});

const storageSchema = z.object({
  captureDir: z.string().min(1),
  rotation: z.object({
    maxBytes: z.coerce.number().int().positive(),
    maxIntervalMs: z.coerce.number().int().positive(),
  }),
  retention: z.object({
    maxAgeMs: z.coerce.number().int().positive(),
    maxTotalBytes: z.coerce.number().int().positive(),
  }),
  compression: z.object({
    enabled: z.coerce.boolean().default(true),
    afterMs: z.coerce.number().int().positive(),
  }),
});

const subcarrierSelectionSchema = z.union([
  z.literal('all'),
  z.array(z.coerce.number().int().nonnegative()),
]);

const featuresSchema = z.object({
  windowMs: z.coerce.number().int().positive(),
  hopMs: z.coerce.number().int().positive(),
  subcarrierSelection: subcarrierSelectionSchema,
  baselineAdaptationRate: z.coerce.number().min(0).max(1),
});

const occupancySchema = z.object({
  thresholds: z.object({
    motionOnThreshold: z.coerce.number().nonnegative(),
    motionOffThreshold: z.coerce.number().nonnegative(),
  }),
  latchDecayHorizonMs: z.coerce.number().int().positive(),
  hysteresisMs: z.coerce.number().int().nonnegative(),
  multiOccupancy: z.object({
    crossNodeSimultaneityThresholdMs: z.coerce.number().int().nonnegative(),
  }),
});

const loggingSchema = z.object({
  level: logLevelSchema,
  file: z.object({
    path: z.string().min(1),
    maxFiles: z.coerce.number().int().positive(),
    maxSizeMb: z.coerce.number().int().positive(),
  }),
});

// Entirely optional, unlike every section above: this knob was added after
// the rest of the schema (brief B8, docs/architecture.md "Data lifecycle"),
// and @homecsi/labeling's training-set preservation already has sane
// built-in fallback constants (see trainingPreservation.ts) for when it's
// omitted. Making the whole section optional -- rather than giving each
// field a zod `.default()` -- keeps `Config` structurally backward
// compatible for any code that builds a `Config` object literal directly
// (bypassing loadConfig/zod parsing, e.g. test helpers in sibling
// packages) without those call sites needing to learn about this key.
const trainingSchema = z
  .object({
    preservation: z.object({
      // Length of the recent "known-alive" window used as this
      // deployment's live feature-row density baseline, which a preserved
      // window's own density is compared against (see
      // trainingPreservation.ts's `checkDensity`) -- self-calibrates to
      // this house's actual mesh/audibility instead of assuming every
      // node hears every other node.
      baselineWindowMs: z.coerce.number().int().positive(),
      // Minimum fraction of that live baseline's density a preserved
      // window must show to be treated as healthy rather than partially
      // or fully retention-dropped. Set to 0 to disable the density
      // sanity-check entirely (trust `found` as-is).
      minDensityFraction: z.coerce.number().min(0).max(1),
    }),
  })
  .optional();

// Entirely optional, like `training` above and for the same reason: this
// section was added after the rest of the schema (brief B1, the device
// OTA HTTP surface -- docs/device-api.md), and @homecsi/api's device
// routes already have a sane built-in default (DEFAULT_OTA_FIRMWARE_DIR)
// for when it's omitted. Keeping the whole section optional -- instead of
// giving `firmwareDir` a zod `.default()` -- keeps `Config` structurally
// backward compatible for any code that builds a `Config` object literal
// directly (bypassing loadConfig/zod parsing, e.g. test helpers in
// sibling packages) without those call sites needing to learn about this
// key.
const otaSchema = z
  .object({
    // Directory containing manifest.json + the firmware image it names
    // (docs/device-api.md). Defaults to /data/firmware -- the in-container
    // data path (ops/docker-compose.yml) -- when this whole section is
    // omitted.
    firmwareDir: z.string().min(1),
  })
  .optional();

// One profile of device-facing polling/sounding knobs `GET /device/mode`
// (docs/device-api.md) hands back -- the same shape is used for both the
// steady-state ("normal") and temporarily-intensified ("realtime")
// profiles below, so the two can never structurally drift from each other.
const deviceModeProfileSchema = z.object({
  pollIntervalS: z.coerce.number().int().positive(),
  soundingIntervalMs: z.coerce.number().int().positive(),
  soundingRps: z.coerce.number().positive(),
  flushBudgetMs: z.coerce.number().int().positive(),
  maxRecordsPerBatch: z.coerce.number().int().positive(),
});

// Entirely optional, like `training`/`ota` above and for the same reason:
// added after the rest of the schema (brief B1's realtime/box-experiment
// plumbing), with sane built-in defaults on the consuming side
// (@homecsi/ingest's persistedRateLimiter.ts, @homecsi/api's
// realtime/deviceModeStore.ts) for when it's omitted -- keeping the whole
// section optional (rather than `.default()`-ing every leaf) keeps
// `Config` structurally backward compatible for any code that builds a
// `Config` object literal directly (test helpers in sibling packages)
// without those call sites needing to learn about this key.
const realtimeSchema = z
  .object({
    // Per-(node_id, link_mac) token-bucket ceiling on CSI records reaching
    // DbWriteQueue (packages/storage/src/dbWriter.ts) -- the persisted-rate
    // invariant that holds regardless of which OS process (ingest) or
    // which knob (device mode, below) is currently in effect. Mirrors
    // firmware/esp32-csi-node/components/csi_protocol/bw_budget.c's
    // integer token-bucket pattern (refill by elapsed time, count what you
    // drop), reimplemented rather than shared across the language boundary.
    // NEVER applies to CaptureWriter -- see @homecsi/ingest's engine.ts.
    persistedRateCeiling: z.object({
      recordsPerSec: z.coerce.number().positive(),
      burstRecords: z.coerce.number().positive(),
    }),
    // `GET /device/mode` (docs/device-api.md) knobs and their caps.
    device: z.object({
      normal: deviceModeProfileSchema,
      realtime: deviceModeProfileSchema,
      // Applied when `POST /api/realtime` omits `durationS`.
      defaultDurationS: z.coerce.number().int().positive(),
      // `POST /api/realtime` rejects any `durationS` above this. Realtime
      // always carries a hard `expiresAt` (never open-ended) so a node
      // that loses the server reverts to `normal` on its own local clock
      // -- the safety property that makes this feature safe to ship.
      maxDurationS: z.coerce.number().int().positive(),
    }),
    // How fast the dashboard's live `csi` WebSocket channel polls
    // (packages/api/src/live/hub.ts) while at least one `box_sessions` row
    // is open -- fast enough to watch a hand move, reverting to that
    // channel's normal interval the moment the session closes.
    liveView: z.object({
      burstPollIntervalMs: z.coerce.number().int().positive(),
    }),
  })
  .optional();

export const configSchema = z.object({
  server: serverSchema,
  database: databaseSchema,
  nodes: z.array(nodeSchema),
  storage: storageSchema,
  features: featuresSchema,
  occupancy: occupancySchema,
  logging: loggingSchema,
  training: trainingSchema,
  ota: otaSchema,
  realtime: realtimeSchema,
});

export type Config = z.infer<typeof configSchema>;
