import { Writable } from 'node:stream';
import pino from 'pino';
import type { Config } from '@homecsi/config';
import { RingLogBuffer } from './ringBuffer.js';

const PINO_LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const RING_BUFFER_CAPACITY = 5000;

class RingBufferSink extends Writable {
  constructor(private readonly buffer: RingLogBuffer) {
    super();
  }

  override _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const levelNumber = typeof parsed.level === 'number' ? parsed.level : 30;
        const time = typeof parsed.time === 'number' ? new Date(parsed.time).toISOString() : new Date().toISOString();
        const msg = typeof parsed.msg === 'string' ? parsed.msg : '';
        this.buffer.push({ ...parsed, time, level: PINO_LEVEL_LABELS[levelNumber] ?? 'info', msg });
      } catch {
        // Non-JSON line (shouldn't happen with pino's default formatter) — skip rather than crash logging.
      }
    }
    callback();
  }
}

export interface AppLogger {
  logger: pino.Logger;
  ringBuffer: RingLogBuffer;
}

/**
 * Builds the process pino logger per `config.logging.level`, fanning out to
 * stdout (for `journald`/container log collection) and an in-memory ring
 * buffer that backs the API's `/api/logs` tail endpoint.
 */
export function createAppLogger(logging: Config['logging']): AppLogger {
  const ringBuffer = new RingLogBuffer(RING_BUFFER_CAPACITY);
  const stream = pino.multistream([
    { stream: process.stdout },
    { stream: new RingBufferSink(ringBuffer) },
  ]);
  const logger = pino({ level: logging.level }, stream);
  return { logger, ringBuffer };
}
