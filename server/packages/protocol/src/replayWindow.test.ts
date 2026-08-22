import { describe, expect, it } from 'vitest';
import { ReplayWindow } from './replayWindow.js';

describe('ReplayWindow', () => {
  it('accepts the first datagram ever seen', () => {
    const w = new ReplayWindow();
    expect(w.check(1, 0)).toEqual({ accepted: true, reason: 'first' });
  });

  it('accepts strictly increasing seq within the same epoch', () => {
    const w = new ReplayWindow();
    w.check(1, 0);
    expect(w.check(1, 1)).toEqual({ accepted: true, reason: 'ok' });
    expect(w.check(1, 2)).toEqual({ accepted: true, reason: 'ok' });
    expect(w.check(1, 100)).toEqual({ accepted: true, reason: 'ok' });
  });

  it('rejects an exact duplicate seq', () => {
    const w = new ReplayWindow();
    w.check(1, 0);
    w.check(1, 5);
    expect(w.check(1, 5)).toEqual({ accepted: false, reason: 'duplicate' });
  });

  it('accepts out-of-order but not-yet-seen seq within the window', () => {
    const w = new ReplayWindow();
    w.check(1, 0);
    w.check(1, 10); // jump ahead
    // 5 through 9 were skipped over and are within the window; each should
    // be accepted exactly once.
    expect(w.check(1, 7)).toEqual({ accepted: true, reason: 'ok' });
    expect(w.check(1, 7)).toEqual({ accepted: false, reason: 'duplicate' });
    expect(w.check(1, 3)).toEqual({ accepted: true, reason: 'ok' });
  });

  it('rejects a seq older than the window', () => {
    const w = new ReplayWindow(64);
    w.check(1, 0);
    w.check(1, 1000);
    // highestSeq is now 1000; anything <= 1000 - 64 is too old.
    expect(w.check(1, 900)).toEqual({ accepted: false, reason: 'too_old' });
  });

  it('handles a shift larger than the window size without throwing', () => {
    const w = new ReplayWindow(64);
    w.check(1, 0);
    // A huge forward jump should just reset the bitmap cleanly.
    expect(w.check(1, 1_000_000)).toEqual({ accepted: true, reason: 'ok' });
    expect(w.check(1, 1_000_001)).toEqual({ accepted: true, reason: 'ok' });
    expect(w.check(1, 1_000_001)).toEqual({ accepted: false, reason: 'duplicate' });
  });

  it('accepts a new, higher boot_epoch and resets the window', () => {
    const w = new ReplayWindow();
    w.check(1, 500);
    w.check(1, 501);
    // Node rebooted: new epoch, seq restarts at 0. Must be accepted even
    // though 0 << 501 would be "too_old" in the old epoch.
    expect(w.check(2, 0)).toEqual({ accepted: true, reason: 'new_epoch' });
    // seq space is independent per epoch now.
    expect(w.check(2, 1)).toEqual({ accepted: true, reason: 'ok' });
    expect(w.check(2, 0)).toEqual({ accepted: false, reason: 'duplicate' });
  });

  it('rejects a boot_epoch rollback (stale epoch)', () => {
    const w = new ReplayWindow();
    w.check(3, 0);
    w.check(4, 0);
    // A datagram claiming an older epoch than the highest seen is rejected,
    // even with a seq that would otherwise look fine.
    expect(w.check(3, 999)).toEqual({ accepted: false, reason: 'stale_epoch' });
    expect(w.check(1, 0)).toEqual({ accepted: false, reason: 'stale_epoch' });
  });

  it('keeps independent state across separate instances (per-node isolation)', () => {
    const a = new ReplayWindow();
    const b = new ReplayWindow();
    a.check(1, 0);
    a.check(1, 1);
    // b has seen nothing yet, so seq 0 is still "first" for it.
    expect(b.check(1, 0)).toEqual({ accepted: true, reason: 'first' });
  });

  describe('seq exhaustion boundary (docs/protocol.md section 4.1)', () => {
    it('accepts seq = 0xFFFFFFFF as an ordinary, non-sentinel value', () => {
      const w = new ReplayWindow();
      expect(w.check(1, 0xfffffffe)).toEqual({ accepted: true, reason: 'first' });
      expect(w.check(1, 0xffffffff)).toEqual({ accepted: true, reason: 'ok' });
    });

    it('rejects a would-be-wrapped seq = 0 following seq = 0xFFFFFFFF in the SAME epoch', () => {
      // A compliant node never sends this (seq must not wrap — section
      // 4.1), but if a buggy sender ever did, the sliding window must not
      // silently accept it as if it were legitimate reordering: it is
      // indistinguishable from "too old" at this distance, which is
      // exactly the safety property that matters here.
      const w = new ReplayWindow();
      w.check(1, 0xffffffff);
      expect(w.check(1, 0)).toEqual({ accepted: false, reason: 'too_old' });
    });

    it('accepts seq = 0 again only once boot_epoch has actually advanced', () => {
      const w = new ReplayWindow();
      w.check(1, 0xffffffff);
      // A real reboot bumps boot_epoch, which is the ONLY sanctioned way
      // to reuse seq = 0 (docs/protocol.md section 4.1).
      expect(w.check(2, 0)).toEqual({ accepted: true, reason: 'new_epoch' });
    });
  });
});
