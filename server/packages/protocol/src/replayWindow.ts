/** Default sliding-window size in bits, per docs/protocol.md section 6. */
export const DEFAULT_WINDOW_BITS = 1024;

export type ReplayReason = 'first' | 'new_epoch' | 'ok' | 'stale_epoch' | 'too_old' | 'duplicate';

export interface ReplayResult {
  accepted: boolean;
  reason: ReplayReason;
}

/**
 * Pure, in-memory implementation of the anti-replay acceptance rule from
 * docs/protocol.md section 6, for a single node's datagram stream. Callers
 * (ingest, brief B3) own one instance per `node_id`.
 *
 * The window uses an RFC 6479-style sliding bitmap: bit `k` set means the
 * datagram with `seq == highestSeq - k` has already been accepted.
 */
export class ReplayWindow {
  private readonly windowBits: number;
  private readonly windowMask: bigint;
  private highestEpoch: number | null = null;
  private highestSeq: number | null = null;
  private bitmap = 0n;

  constructor(windowBits: number = DEFAULT_WINDOW_BITS) {
    if (!Number.isInteger(windowBits) || windowBits <= 0) {
      throw new RangeError(`windowBits must be a positive integer, got ${windowBits}`);
    }
    this.windowBits = windowBits;
    this.windowMask = (1n << BigInt(windowBits)) - 1n;
  }

  /**
   * Evaluates (and, if accepted, records) one datagram identified by
   * `(bootEpoch, seq)`. `node_id` is not part of this class's state — one
   * instance already represents exactly one node.
   */
  check(bootEpoch: number, seq: number): ReplayResult {
    if (
      !Number.isInteger(bootEpoch) ||
      bootEpoch < 0 ||
      !Number.isInteger(seq) ||
      seq < 0
    ) {
      throw new RangeError('bootEpoch and seq must be non-negative integers');
    }

    if (this.highestEpoch === null || this.highestSeq === null) {
      this.highestEpoch = bootEpoch;
      this.highestSeq = seq;
      this.bitmap = 1n;
      return { accepted: true, reason: 'first' };
    }

    if (bootEpoch < this.highestEpoch) {
      return { accepted: false, reason: 'stale_epoch' };
    }

    if (bootEpoch > this.highestEpoch) {
      this.highestEpoch = bootEpoch;
      this.highestSeq = seq;
      this.bitmap = 1n;
      return { accepted: true, reason: 'new_epoch' };
    }

    // Same epoch as the current high-water mark.
    if (seq > this.highestSeq) {
      const shift = seq - this.highestSeq;
      this.bitmap = shift >= this.windowBits ? 0n : (this.bitmap << BigInt(shift)) & this.windowMask;
      this.bitmap |= 1n;
      this.highestSeq = seq;
      return { accepted: true, reason: 'ok' };
    }

    const age = this.highestSeq - seq;
    if (age >= this.windowBits) {
      return { accepted: false, reason: 'too_old' };
    }
    const bit = 1n << BigInt(age);
    if ((this.bitmap & bit) !== 0n) {
      return { accepted: false, reason: 'duplicate' };
    }
    this.bitmap |= bit;
    return { accepted: true, reason: 'ok' };
  }
}
