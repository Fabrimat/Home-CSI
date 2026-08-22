import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeCsiDb } from '../db/types.js';
import { LiveHub } from './hub.js';

/** Minimal fake standing in for a `ws.WebSocket`, just enough for the hub. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function makeDb(overrides: Partial<HomeCsiDb> = {}): HomeCsiDb {
  return {
    healthCheck: vi.fn(),
    listNodes: vi.fn(),
    listHeartbeats: vi.fn(),
    pollHeartbeats: vi.fn().mockResolvedValue([]),
    listLinks: vi.fn(),
    listCsiRecords: vi.fn(),
    pollCsiRecords: vi.fn().mockResolvedValue([]),
    listFeatures: vi.fn(),
    listOccupancyStates: vi.fn(),
    pollOccupancyStates: vi.fn().mockResolvedValue([]),
    getStatusSummary: vi.fn(),
    listLabelSessions: vi.fn(),
    createLabelSession: vi.fn(),
    stopLabelSession: vi.fn(),
    listLabels: vi.fn(),
    createLabel: vi.fn(),
    ...overrides,
  } as unknown as HomeCsiDb;
}

describe('LiveHub', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls and delivers a coalesced batch of new rows to every subscriber of the same feed', async () => {
    const pollCsiRecords = vi
      .fn()
      .mockResolvedValueOnce([
        { time: '2026-01-01T00:00:01.000Z', rssi: -40, noiseFloor: -90, csiFormat: 0, amplitudes: [1] },
        { time: '2026-01-01T00:00:02.000Z', rssi: -41, noiseFloor: -90, csiFormat: 0, amplitudes: [2] },
      ])
      .mockResolvedValue([]);
    const db = makeDb({ pollCsiRecords });
    const hub = new LiveHub(db, { warn: vi.fn() });

    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    const sub = { channel: 'csi' as const, nodeId: 1, srcMac: 'aa:bb:cc:dd:ee:01', dstMac: 'aa:bb:cc:dd:ee:02' };
    hub.subscribe(socketA as never, sub);
    hub.subscribe(socketB as never, sub);

    await vi.advanceTimersByTimeAsync(750);

    // One shared poller for both subscribers of the same (channel, link) feed.
    expect(pollCsiRecords).toHaveBeenCalledTimes(1);
    expect(socketA.sent).toHaveLength(1);
    expect(socketB.sent).toHaveLength(1);
    const payload = JSON.parse(socketA.sent[0] as string) as { records: unknown[] };
    expect(payload.records).toHaveLength(2);
  });

  it('stops polling once the last subscriber unsubscribes', async () => {
    const pollOccupancyStates = vi.fn().mockResolvedValue([]);
    const db = makeDb({ pollOccupancyStates });
    const hub = new LiveHub(db, { warn: vi.fn() });
    const socket = new FakeSocket();
    hub.subscribe(socket as never, { channel: 'occupancy' });
    await vi.advanceTimersByTimeAsync(750);
    expect(pollOccupancyStates).toHaveBeenCalledTimes(1);

    hub.unsubscribe(socket as never, { channel: 'occupancy' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(pollOccupancyStates).toHaveBeenCalledTimes(1);
  });

  it('drops a batch for a socket whose outbound buffer is already full (backpressure) without throwing', async () => {
    const pollOccupancyStates = vi
      .fn()
      .mockResolvedValue([{ time: '2026-01-01T00:00:01.000Z', estimate: 1, confidence: 0.9, state: 'occupied', details: null }]);
    const db = makeDb({ pollOccupancyStates });
    const hub = new LiveHub(db, { warn: vi.fn() });
    const socket = new FakeSocket();
    socket.bufferedAmount = 10_000_000; // way over the backpressure threshold
    hub.subscribe(socket as never, { channel: 'occupancy' });

    await expect(vi.advanceTimersByTimeAsync(750)).resolves.not.toThrow();
    expect(socket.sent).toHaveLength(0);
  });

  it('releases a feed when the socket is removed via removeSocket (disconnect cleanup)', async () => {
    const pollHeartbeats = vi.fn().mockResolvedValue([]);
    const db = makeDb({ pollHeartbeats });
    const hub = new LiveHub(db, { warn: vi.fn() });
    const socket = new FakeSocket();
    hub.subscribe(socket as never, { channel: 'heartbeat', nodeId: 1 });
    hub.removeSocket(socket as never);
    await vi.advanceTimersByTimeAsync(3000);
    expect(pollHeartbeats).not.toHaveBeenCalled();
  });
});
