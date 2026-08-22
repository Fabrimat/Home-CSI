import { describe, expect, it } from 'vitest';
import { CsiFormat } from '@homecsi/protocol';
import {
  CsiParseError,
  SubcarrierSelectionError,
  excludeNullSubcarriers,
  normalizeAmplitudes,
  parseCsiAmplitudes,
  selectSubcarriers,
} from './csiParsing.js';

/** Builds a raw csi_data buffer from [I, Q] signed pairs. */
function iqBuffer(pairs: Array<[number, number]>): Buffer {
  const buf = Buffer.alloc(pairs.length * 2);
  pairs.forEach(([i, q], idx) => {
    buf.writeInt8(i, idx * 2);
    buf.writeInt8(q, idx * 2 + 1);
  });
  return buf;
}

describe('parseCsiAmplitudes: variable record length is format-dependent', () => {
  it('parses a small LLTF-only record (few subcarriers)', () => {
    const data = iqBuffer([
      [3, 4],
      [0, 0],
      [-3, 4],
    ]);
    const parsed = parseCsiAmplitudes(data, CsiFormat.Lltf);
    expect(parsed.subcarrierCount).toBe(3);
    expect(parsed.amplitudes[0]).toBeCloseTo(5, 10);
    expect(parsed.amplitudes[2]).toBeCloseTo(5, 10);
    expect(parsed.nullSubcarrierIndices).toEqual([1]);
  });

  it('parses a larger LLTF+HT-LTF record with a different subcarrier count from the same decoder', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => [i, 0]);
    const data = iqBuffer(pairs);
    const parsed = parseCsiAmplitudes(data, CsiFormat.LltfHtLtf);
    // Same byte-pair decoding logic, but a record-specific subcarrier count —
    // no fixed constant is assumed anywhere in the parser.
    expect(parsed.subcarrierCount).toBe(20);
    expect(parsed.amplitudes[5]).toBeCloseTo(5, 10);
  });

  it('never assumes a subcarrier count is shared between two differently-sized records', () => {
    const small = parseCsiAmplitudes(iqBuffer([[1, 0]]), CsiFormat.Lltf);
    const large = parseCsiAmplitudes(
      iqBuffer(Array.from({ length: 96 }, () => [1, 0] as [number, number])),
      CsiFormat.LltfHtLtf,
    );
    expect(small.subcarrierCount).not.toBe(large.subcarrierCount);
    expect(small.subcarrierCount).toBe(1);
    expect(large.subcarrierCount).toBe(96);
  });

  it('throws on an unassigned/unknown csi_format (opaque data)', () => {
    const data = iqBuffer([[1, 1]]);
    expect(() => parseCsiAmplitudes(data, 200)).toThrow(CsiParseError);
  });

  it('throws on empty csi_data', () => {
    expect(() => parseCsiAmplitudes(Buffer.alloc(0), CsiFormat.Lltf)).toThrow(CsiParseError);
  });

  it('throws on an odd number of bytes (not a whole number of I/Q pairs)', () => {
    expect(() => parseCsiAmplitudes(Buffer.alloc(3), CsiFormat.Lltf)).toThrow(CsiParseError);
  });
});

describe('excludeNullSubcarriers', () => {
  it('drops indices where I and Q are both exactly zero', () => {
    const parsed = parseCsiAmplitudes(
      iqBuffer([
        [3, 4],
        [0, 0],
        [1, 1],
      ]),
      CsiFormat.Lltf,
    );
    const filtered = excludeNullSubcarriers(parsed);
    expect(filtered.length).toBe(2);
  });

  it('is a no-op when there are no null subcarriers', () => {
    const parsed = parseCsiAmplitudes(
      iqBuffer([
        [3, 4],
        [1, 1],
      ]),
      CsiFormat.Lltf,
    );
    expect(excludeNullSubcarriers(parsed).length).toBe(2);
  });
});

describe('selectSubcarriers: explicit selection must be validated against each record`s actual layout', () => {
  const amplitudes = Float64Array.from([1, 2, 3, 4]);

  it('"all" keeps every subcarrier', () => {
    expect(Array.from(selectSubcarriers(amplitudes, 'all', 4))).toEqual([1, 2, 3, 4]);
  });

  it('an explicit list valid for this layout picks the requested subcarriers', () => {
    expect(Array.from(selectSubcarriers(amplitudes, [0, 2], 4))).toEqual([1, 3]);
  });

  it('an explicit list valid for a *larger* format is rejected against a smaller record`s actual layout', () => {
    // e.g. configured assuming LLTF+HT-LTF (~192 subcarriers) but this
    // record is LLTF-only (4, in this synthetic example) — must not be
    // silently truncated or assumed valid.
    expect(() => selectSubcarriers(amplitudes, [0, 1, 50], 4)).toThrow(SubcarrierSelectionError);
  });

  it('rejects a negative index', () => {
    expect(() => selectSubcarriers(amplitudes, [-1], 4)).toThrow(SubcarrierSelectionError);
  });
});

describe('normalizeAmplitudes', () => {
  it('scales an amplitude vector to unit RMS', () => {
    const normalized = normalizeAmplitudes(Float64Array.from([3, 4]));
    const rms = Math.sqrt((normalized[0]! ** 2 + normalized[1]! ** 2) / 2);
    expect(rms).toBeCloseTo(1, 10);
  });

  it('two records of the same shape at different AGC gain (different absolute magnitude) normalise to the same relative pattern', () => {
    const low = normalizeAmplitudes(Float64Array.from([1, 2, 3]));
    const high = normalizeAmplitudes(Float64Array.from([10, 20, 30]));
    for (let i = 0; i < low.length; i++) {
      expect(low[i]).toBeCloseTo(high[i] as number, 8);
    }
  });

  it('does not divide by zero for an all-zero vector', () => {
    const out = normalizeAmplitudes(Float64Array.from([0, 0, 0]));
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });
});
