import { describe, expect, it } from 'vitest';
import {
  buildStepSegments,
  currentRunStartMs,
  isUnobservedGap,
  KEEPALIVE_INTERVAL_MS,
  type OccupancyRow,
} from './occupancySeries.js';

const FROM = Date.parse('2026-01-01T12:00:00.000Z');
const TO = Date.parse('2026-01-01T13:00:00.000Z');

function row(time: string, over: Partial<OccupancyRow> = {}): OccupancyRow {
  return {
    time,
    estimate: 1,
    confidence: 0.85,
    state: 'OCCUPIED',
    kind: 'transition',
    details: null,
    ...over,
  };
}

describe('buildStepSegments', () => {
  it('carries a single pre-window event across the whole window (no data-less gap)', () => {
    // The house went OCCUPIED three hours before the window and nothing has
    // changed since — the sparse log has exactly one relevant row, and it is
    // older than `from`.
    const segments = buildStepSegments([row('2026-01-01T09:00:00.000Z')], FROM, TO);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.startMs).toBe(FROM);
    expect(segments[0]?.endMs).toBe(TO);
    expect(segments[0]?.row.state).toBe('OCCUPIED');
    // The event's real timestamp survives, so the UI can say "since 09:00".
    expect(segments[0]?.row.time).toBe('2026-01-01T09:00:00.000Z');
  });

  it('holds each value until the next event rather than interpolating between them', () => {
    const segments = buildStepSegments(
      [
        row('2026-01-01T09:00:00.000Z', { estimate: 0, state: 'UNOCCUPIED' }),
        row('2026-01-01T12:30:00.000Z', { estimate: 2, state: 'OCCUPIED' }),
      ],
      FROM,
      TO,
    );

    expect(segments.map((s) => [s.startMs, s.endMs, s.row.estimate])).toEqual([
      [FROM, Date.parse('2026-01-01T12:30:00.000Z'), 0],
      [Date.parse('2026-01-01T12:30:00.000Z'), TO, 2],
    ]);
  });

  it('extends the last event to the end of the window', () => {
    const segments = buildStepSegments([row('2026-01-01T12:45:00.000Z')], FROM, TO);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.startMs).toBe(Date.parse('2026-01-01T12:45:00.000Z'));
    expect(segments[0]?.endMs).toBe(TO);
  });

  it('returns nothing when the log really is empty', () => {
    expect(buildStepSegments([], FROM, TO)).toEqual([]);
  });

  it('drops zero-width segments produced by two events on the same instant', () => {
    const segments = buildStepSegments(
      [row('2026-01-01T12:30:00.000Z'), row('2026-01-01T12:30:00.000Z', { state: 'DECAYING' })],
      FROM,
      TO,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.row.state).toBe('DECAYING');
  });
});

describe('currentRunStartMs', () => {
  it('walks back over keepalives to the transition that started the current state', () => {
    const rows = [
      row('2026-01-01T08:00:00.000Z', { state: 'UNOCCUPIED', estimate: 0 }),
      row('2026-01-01T09:00:00.000Z', { state: 'OCCUPIED' }),
      row('2026-01-01T09:15:00.000Z', { state: 'OCCUPIED', kind: 'keepalive' }),
      row('2026-01-01T09:30:00.000Z', { state: 'OCCUPIED', kind: 'keepalive' }),
    ];

    expect(currentRunStartMs(rows)).toBe(Date.parse('2026-01-01T09:00:00.000Z'));
  });

  it('is null when there is no history at all', () => {
    expect(currentRunStartMs([])).toBeNull();
  });
});

describe('isUnobservedGap', () => {
  it('flags a held span longer than two keepalive intervals as unobserved, not as a quiet house', () => {
    // Keepalives land every KEEPALIVE_INTERVAL_MS of tick time while the
    // pipeline is running, so a longer span means it was not observing.
    expect(isUnobservedGap({ startMs: 0, endMs: 2 * KEEPALIVE_INTERVAL_MS + 1, row: row('2026-01-01T00:00:00.000Z') })).toBe(true);
  });

  it('does not flag a normal quiet stretch punctuated by keepalives', () => {
    expect(isUnobservedGap({ startMs: 0, endMs: KEEPALIVE_INTERVAL_MS, row: row('2026-01-01T00:00:00.000Z') })).toBe(false);
  });
});
