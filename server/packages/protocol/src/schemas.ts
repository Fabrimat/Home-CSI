import { z } from 'zod';

const macSchema = z.string().regex(/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/, 'invalid MAC address');

export const csiRecordSchema = z.object({
  srcMac: macSchema,
  dstMac: macSchema,
  rssi: z.number().int(),
  rate: z.number().int().min(0).max(0xff),
  sigMode: z.number().int().min(0).max(0xff),
  mcs: z.number().int().min(0).max(0xff),
  bandwidth: z.number().int().min(0).max(0xff),
  channel: z.number().int().min(0).max(0xff),
  secondaryChannel: z.number().int().min(0).max(0xff),
  noiseFloor: z.number().int(),
  rxTimestampUs: z.bigint().nonnegative(),
  csiFormat: z.number().int().min(0).max(0xff),
  csiData: z.instanceof(Uint8Array),
});
export type CsiRecordShape = z.infer<typeof csiRecordSchema>;

export const csiBatchSchema = z.object({
  wallClockUs: z.bigint().nonnegative(),
  monoUs: z.bigint().nonnegative(),
  sntpSynced: z.boolean(),
  records: z.array(csiRecordSchema),
});
export type CsiBatchShape = z.infer<typeof csiBatchSchema>;

export const heartbeatSchema = z.object({
  uptimeS: z.number().int().nonnegative(),
  freeHeapBytes: z.number().int().nonnegative(),
  minFreeHeapBytes: z.number().int().nonnegative(),
  framesCaptured: z.number().int().nonnegative(),
  framesDropped: z.number().int().nonnegative(),
  batchesSent: z.number().int().nonnegative(),
  sendFailures: z.number().int().nonnegative(),
  rssiToAp: z.number().int(),
  channel: z.number().int().min(0).max(0xff),
  sntpSynced: z.boolean(),
  fwVersionMajor: z.number().int().min(0).max(0xff),
  fwVersionMinor: z.number().int().min(0).max(0xff),
  fwVersionPatch: z.number().int().min(0).max(0xff),
});
export type HeartbeatShape = z.infer<typeof heartbeatSchema>;

export const decodedDatagramSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('CSI_BATCH'),
    version: z.number().int(),
    nodeId: z.number().int().min(0).max(0xffff),
    bootEpoch: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    batch: csiBatchSchema,
  }),
  z.object({
    type: z.literal('HEARTBEAT'),
    version: z.number().int(),
    nodeId: z.number().int().min(0).max(0xffff),
    bootEpoch: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    heartbeat: heartbeatSchema,
  }),
]);
export type DecodedDatagramShape = z.infer<typeof decodedDatagramSchema>;
