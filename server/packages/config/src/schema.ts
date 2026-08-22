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

const nodeSchema = z.object({
  id: z.coerce.number().int().min(1).max(65535),
  name: z.string().min(1),
  room: z.string().min(1),
  psk: base64Psk,
  expectedMac: macAddressSchema.optional(),
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

export const configSchema = z.object({
  server: serverSchema,
  database: databaseSchema,
  nodes: z.array(nodeSchema),
  storage: storageSchema,
  features: featuresSchema,
  occupancy: occupancySchema,
  logging: loggingSchema,
  training: trainingSchema,
});

export type Config = z.infer<typeof configSchema>;
