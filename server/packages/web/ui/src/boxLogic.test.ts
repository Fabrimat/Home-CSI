import { describe, expect, it } from 'vitest';
import {
  classReadiness,
  csiFeedKey,
  displayMode,
  formatAccuracyComparison,
  laneStatus,
  LANE_SILENT_AFTER_MS,
  nodePickupStatus,
  robustAmplitudeRange,
  shouldAnnounce,
  type ClassSummary,
  type RealtimeNodeState,
} from './boxLogic.js';

describe('displayMode', () => {
  it('passes the server mode through once it is known-since-restart', () => {
    expect(displayMode('normal', true)).toBe('normal');
    expect(displayMode('realtime', true)).toBe('realtime');
  });

  it('never renders "normal" as a confirmed fact when the hub does not know yet', () => {
    expect(displayMode('normal', false)).toBe('unknown');
    expect(displayMode('realtime', false)).toBe('unknown');
    expect(displayMode('unknown', false)).toBe('unknown');
  });
});

describe('nodePickupStatus', () => {
  const targetRevision = 7;

  it('is "applied" once the node reports the target revision', () => {
    const node: RealtimeNodeState = { nodeId: 1, lastPolledAt: '2026-08-31T12:00:00.000Z', appliedRevision: 7 };
    expect(nodePickupStatus(node, targetRevision)).toBe('applied');
  });

  it('is "pending" for a node that has polled but not yet caught up', () => {
    const node: RealtimeNodeState = { nodeId: 1, lastPolledAt: '2026-08-31T12:00:00.000Z', appliedRevision: 6 };
    expect(nodePickupStatus(node, targetRevision)).toBe('pending');
  });

  it('is "unseen" for a node that has never polled, distinct from merely pending', () => {
    const node: RealtimeNodeState = { nodeId: 1, lastPolledAt: null, appliedRevision: null };
    expect(nodePickupStatus(node, targetRevision)).toBe('unseen');
  });
});

describe('laneStatus', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');

  it('is "no-link" when no record has ever arrived', () => {
    expect(laneStatus(null, now)).toBe('no-link');
  });

  it('is "live" just after a record arrives', () => {
    expect(laneStatus(now - 100, now)).toBe('live');
  });

  it('is "silent" once the gap exceeds the threshold, never drawn as live', () => {
    expect(laneStatus(now - LANE_SILENT_AFTER_MS - 1, now)).toBe('silent');
  });

  it('treats exactly the threshold as still live', () => {
    expect(laneStatus(now - LANE_SILENT_AFTER_MS, now)).toBe('live');
  });
});

describe('csiFeedKey', () => {
  it('matches the API hub\'s feedKey format for the csi channel exactly', () => {
    expect(csiFeedKey(3, 'aa:bb:cc:dd:ee:ff', 'ff:ff:ff:ff:ff:ff')).toBe('csi:3:aa:bb:cc:dd:ee:ff:ff:ff:ff:ff:ff:ff');
  });

  it('gives different nodes on the same MACs different keys', () => {
    expect(csiFeedKey(1, 'a', 'b')).not.toBe(csiFeedKey(2, 'a', 'b'));
  });
});

describe('robustAmplitudeRange', () => {
  it('clips to [0, 1] when there are no columns at all', () => {
    expect(robustAmplitudeRange([])).toEqual([0, 1]);
  });

  it('widens a flat single value to a non-zero range', () => {
    expect(robustAmplitudeRange([[5, 5, 5]])).toEqual([5, 6]);
  });

  it('clips outliers at the 5th/95th percentile rather than using the raw min/max', () => {
    const values = Array.from({ length: 100 }, (_, i) => i); // 0..99
    const [lo, hi] = robustAmplitudeRange([values]);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(99);
  });
});

describe('classReadiness', () => {
  it('flags a class ready once it has reached the minimum, with zero remaining', () => {
    const cls: ClassSummary = { gestureClass: 'wave', takeCount: 5, totalRecords: 500 };
    expect(classReadiness(cls, 5)).toEqual({ ...cls, ready: true, remaining: 0 });
  });

  it('reports how many more takes a short class needs', () => {
    const cls: ClassSummary = { gestureClass: 'push', takeCount: 2, totalRecords: 200 };
    expect(classReadiness(cls, 5)).toEqual({ ...cls, ready: false, remaining: 3 });
  });

  it('never reports negative remaining for a class past the minimum', () => {
    const cls: ClassSummary = { gestureClass: 'wave', takeCount: 9, totalRecords: 900 };
    expect(classReadiness(cls, 5).remaining).toBe(0);
  });
});

describe('formatAccuracyComparison', () => {
  it('always renders accuracy alongside both baselines, never alone', () => {
    const text = formatAccuracyComparison({ accuracy: 0.62, majorityBaseline: 0.41, randomBaseline: 0.2 });
    expect(text).toContain('62%');
    expect(text).toContain('41%');
    expect(text).toContain('20%');
    expect(text).toContain('majority-class baseline');
    expect(text).toContain('random baseline');
  });
});

describe('shouldAnnounce', () => {
  it('says yes the first time a value is set from empty', () => {
    expect(shouldAnnounce('', 'Normal')).toBe(true);
  });

  it('says no when a poll/tick recomputes the identical text -- this is the bug it exists to prevent', () => {
    expect(shouldAnnounce('Normal', 'Normal')).toBe(false);
  });

  it('says yes on a genuine transition', () => {
    expect(shouldAnnounce('Normal', 'Realtime (burst)')).toBe(true);
  });

  it('says yes going back to a previously-seen value, since it is a fresh transition each time', () => {
    expect(shouldAnnounce('Unknown', 'Normal')).toBe(true);
  });
});
