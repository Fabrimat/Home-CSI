export { replayCaptures } from './replay.js';
export { pruneStorage } from './prune.js';

export { CaptureWriter } from './captureWriter.js';
export type { CaptureWriterOptions } from './captureWriter.js';

export { readShardRecords, listClosedShardFiles } from './captureReader.js';
export type { ShardFileInfo } from './captureReader.js';

export { encodeCaptureRecord, decodeCaptureRecordAt, SHARD_MAGIC } from './captureFormat.js';
export type { CaptureRecordEnvelope } from './captureFormat.js';

export { compressAgedShards } from './compression.js';
export type { CompressAgedShardsResult } from './compression.js';

export { DbWriteQueue } from './dbWriter.js';
export type {
  DbQueryable,
  DbWriteQueueOptions,
  DbWriteQueueMetrics,
  PendingCsiRow,
  PendingHeartbeatRow,
} from './dbWriter.js';

export { resolveCaptureDir } from './paths.js';
export { createRateLimitedLogger, noopLogger } from './logger.js';
export type { BasicLogger } from './logger.js';

export { writeMetricsSnapshot, writeStorageStatus, computeStorageStatus } from './metricsSnapshot.js';
export type { MetricsSnapshotEntry, StorageStatus } from './metricsSnapshot.js';
