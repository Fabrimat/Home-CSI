import { describe, it, expect } from 'vitest';
import { seriesDomain, describeDomain, formatSpan, MIN_SPAN_MS } from './featureScale.js';

const at = (iso: string): { time: string } => ({ time: iso });
const NOW = Date.parse('2026-08-29T13:40:00.000Z');

describe('seriesDomain', () => {
  it('fits the domain to the data, not to the requested lookback window', () => {
    // The bug this exists to prevent: 20 minutes of rows asked for over a
    // 30-minute window used to be drawn against the full 30 minutes, pinning
    // every point to the right-hand third of the chart.
    const points = [at('2026-08-29T13:20:00.000Z'), at('2026-08-29T13:34:00.000Z')];
    const d = seriesDomain(points, NOW);
    expect(d.fromMs).toBeLessThanOrEqual(Date.parse('2026-08-29T13:20:00.000Z'));
    expect(d.toMs).toBeGreaterThanOrEqual(Date.parse('2026-08-29T13:34:00.000Z'));
    // Crucially it does NOT run to `now`, which is 6 minutes past the last sample.
    expect(d.toMs).toBeLessThan(NOW);
  });

  it('pads both ends so the first and last sample are not on the axis', () => {
    const lo = Date.parse('2026-08-29T13:00:00.000Z');
    const hi = Date.parse('2026-08-29T13:30:00.000Z');
    const d = seriesDomain([at(new Date(lo).toISOString()), at(new Date(hi).toISOString())], NOW);
    expect(d.fromMs).toBeLessThan(lo);
    expect(d.toMs).toBeGreaterThan(hi);
  });

  it('widens a single-sample series to a readable minimum span', () => {
    const d = seriesDomain([at('2026-08-29T13:30:00.000Z')], NOW);
    expect(d.toMs - d.fromMs).toBeGreaterThanOrEqual(MIN_SPAN_MS);
  });

  it('widens a series whose samples span less than the minimum', () => {
    const d = seriesDomain([at('2026-08-29T13:30:00.000Z'), at('2026-08-29T13:30:02.000Z')], NOW);
    expect(d.toMs - d.fromMs).toBeGreaterThanOrEqual(MIN_SPAN_MS);
  });

  it('anchors an empty series to now rather than producing an infinite domain', () => {
    const d = seriesDomain([], NOW);
    expect(Number.isFinite(d.fromMs)).toBe(true);
    expect(d.toMs).toBe(NOW);
    expect(d.toMs - d.fromMs).toBe(MIN_SPAN_MS);
  });

  it('ignores unparseable timestamps instead of poisoning the domain with NaN', () => {
    const d = seriesDomain([at('nonsense'), at('2026-08-29T13:30:00.000Z')], NOW);
    expect(Number.isFinite(d.fromMs)).toBe(true);
    expect(Number.isFinite(d.toMs)).toBe(true);
  });

  it('falls back to the now-anchored window when every timestamp is unparseable', () => {
    const d = seriesDomain([at('nonsense'), at('also nonsense')], NOW);
    expect(d.toMs).toBe(NOW);
  });
});

describe('formatSpan', () => {
  it('uses seconds under a minute', () => {
    expect(formatSpan(42_000)).toBe('42s');
  });

  it('uses minutes and zero-padded seconds under an hour', () => {
    expect(formatSpan(7 * 60_000 + 2_000)).toBe('7m 02s');
  });

  it('uses hours and zero-padded minutes above an hour', () => {
    expect(formatSpan(3 * 3_600_000 + 5 * 60_000)).toBe('3h 05m');
  });

  it('never renders a negative span', () => {
    expect(formatSpan(-1000)).toBe('0s');
  });
});

describe('describeDomain', () => {
  it('reports the span alongside the endpoints', () => {
    const from = Date.parse('2026-08-29T13:20:00.000Z');
    const text = describeDomain({ fromMs: from, toMs: from + 90_000 });
    expect(text).toContain('→');
    expect(text).toContain('1m 30s');
  });
});
