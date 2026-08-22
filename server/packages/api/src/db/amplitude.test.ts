import { describe, expect, it } from 'vitest';
import { decodeAmplitudes } from './amplitude.js';

describe('decodeAmplitudes', () => {
  it('derives subcarrier count from byte length, not any assumed constant', () => {
    const shortRecord = Buffer.from([3, 4]); // one I/Q pair -> amplitude 5
    expect(decodeAmplitudes(shortRecord)).toEqual([5]);

    const longRecord = Buffer.alloc(384, 0); // an LLTF_HT_LTF-sized record, all zero I/Q
    expect(decodeAmplitudes(longRecord)).toHaveLength(192);
  });

  it('computes sqrt(I^2 + Q^2) per pair, handling negative signed-8-bit values', () => {
    const buf = Buffer.from([Buffer.from([0x00]).readInt8(0), 0]); // 0,0 -> 0
    expect(decodeAmplitudes(buf)).toEqual([0]);

    const negative = Buffer.alloc(2);
    negative.writeInt8(-3, 0);
    negative.writeInt8(-4, 1);
    expect(decodeAmplitudes(negative)).toEqual([5]);
  });

  it('handles an empty CSI payload', () => {
    expect(decodeAmplitudes(Buffer.alloc(0))).toEqual([]);
  });

  it('ignores a single trailing odd byte rather than throwing', () => {
    expect(decodeAmplitudes(Buffer.from([1, 2, 3]))).toHaveLength(1);
  });
});
