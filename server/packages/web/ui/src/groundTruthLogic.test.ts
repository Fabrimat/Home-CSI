import { describe, expect, it } from 'vitest';
import {
  annotationReviewWindow,
  canDeclare,
  composeLabelNotes,
  composeSessionNotes,
  deriveMissions,
  formatCountdown,
  formatHeldDuration,
  isShortcutSuppressed,
  isSessionOpen,
  isTrainingSession,
  MIN_INTERVAL_MS,
  openDeclarationOf,
  planAnnotationSpan,
  planDeclaration,
  recentLabelChips,
  TRAINING_MARKER,
  type AnnotationRow,
  type ExpiringGap,
  type OpenDeclaration,
} from './groundTruthLogic.js';

const T = (iso: string): number => Date.parse(iso);

function open(id: number, occupancyCount: number): OpenDeclaration {
  return { id, occupancyCount, time: '2026-01-01T12:00:00.000Z', endTime: null };
}

describe('session notes marker', () => {
  it('prefixes operator notes with the training marker', () => {
    expect(composeSessionNotes('  saturday walkthrough ')).toBe('[training] saturday walkthrough');
  });

  it('is still marked when the operator typed nothing', () => {
    expect(composeSessionNotes('   ')).toBe(TRAINING_MARKER);
  });

  it('never produces notes starting with the weak-label prefix (features would silently evaporate)', () => {
    for (const input of ['', 'kitchen', '[weak:phone-presence] sneaky']) {
      expect(composeSessionNotes(input).startsWith('[weak:phone-presence]')).toBe(false);
      expect(isTrainingSession(composeSessionNotes(input))).toBe(true);
    }
  });

  it('recognises only training-marked sessions', () => {
    expect(isTrainingSession('[training] x')).toBe(true);
    expect(isTrainingSession('dashboard correction')).toBe(false);
    expect(isTrainingSession(null)).toBe(false);
  });
});

describe('composeLabelNotes', () => {
  it('joins the context note and motion tag, omitting either when absent', () => {
    expect(composeLabelNotes(' kitchen ', 'still')).toBe('kitchen (still)');
    expect(composeLabelNotes('kitchen', '')).toBe('kitchen');
    expect(composeLabelNotes('  ', 'moving')).toBe('(moving)');
    expect(composeLabelNotes('  ', '')).toBeUndefined();
  });
});

describe('planDeclaration', () => {
  it('is a no-op when the tapped state is already the open one (never a zero-length interval)', () => {
    expect(planDeclaration(open(7, 1), 1)).toEqual({ kind: 'noop' });
  });

  it('closes the open declaration first when the state changes', () => {
    expect(planDeclaration(open(7, 1), 2)).toEqual({ kind: 'declare', closeLabelId: 7 });
  });

  it('opens without closing anything when nothing is open yet', () => {
    expect(planDeclaration(null, 0)).toEqual({ kind: 'declare', closeLabelId: null });
  });

  it('treats 0 as a real state, not a falsy absence', () => {
    expect(planDeclaration(open(9, 0), 0)).toEqual({ kind: 'noop' });
    expect(planDeclaration(open(9, 0), 1)).toEqual({ kind: 'declare', closeLabelId: 9 });
  });
});

describe('canDeclare', () => {
  it('allows a declaration while the session is open', () => {
    expect(canDeclare({ endedAt: null }, false)).toBe(true);
    expect(isSessionOpen({ endedAt: null })).toBe(true);
  });

  it('refuses a declaration once the session has been stopped (no training label may land in a preserved session)', () => {
    expect(canDeclare({ endedAt: '2026-01-01T12:30:00.000Z' }, false)).toBe(false);
    expect(isSessionOpen({ endedAt: '2026-01-01T12:30:00.000Z' })).toBe(false);
  });

  it('refuses a declaration with no session at all', () => {
    expect(canDeclare(null, false)).toBe(false);
    expect(isSessionOpen(null)).toBe(false);
  });

  it('refuses a declaration while a request is already in flight', () => {
    expect(canDeclare({ endedAt: null }, true)).toBe(false);
  });
});

describe('planAnnotationSpan', () => {
  it('records a comfortably long span as a real interval', () => {
    expect(planAnnotationSpan(1_000_000, 1_030_000)).toEqual({ time: 1_000_000, endTime: 1_030_000 });
  });

  it('degrades a sub-threshold double-tap to a point annotation instead of a 400', () => {
    expect(planAnnotationSpan(1_000_000, 1_000_999)).toEqual({ time: 1_000_000, endTime: null });
  });

  it('keeps a span of exactly MIN_INTERVAL_MS as an interval (threshold is the shortest span kept)', () => {
    expect(planAnnotationSpan(1_000_000, 1_000_000 + MIN_INTERVAL_MS)).toEqual({
      time: 1_000_000,
      endTime: 1_000_000 + MIN_INTERVAL_MS,
    });
  });

  it('records a zero-length span as a point at the tap instant', () => {
    expect(planAnnotationSpan(1_000_000, 1_000_000)).toEqual({ time: 1_000_000, endTime: null });
  });
});

describe('openDeclarationOf', () => {
  const closed = { id: 1, endTime: '2026-01-01T12:00:00.000Z' };
  const stillOpen = { id: 2, endTime: null };

  it('finds a trailing open declaration', () => {
    expect(openDeclarationOf([closed, stillOpen])).toBe(stillOpen);
  });

  it('reports none when the last row is closed', () => {
    expect(openDeclarationOf([stillOpen, closed])).toBeNull();
    expect(openDeclarationOf([])).toBeNull();
  });
});

describe('formatHeldDuration', () => {
  it('formats seconds and minutes, clamping negatives', () => {
    expect(formatHeldDuration(45_000)).toBe('45s');
    expect(formatHeldDuration(134_000)).toBe('2m 14s');
    expect(formatHeldDuration(-5)).toBe('0s');
  });
});

describe('formatCountdown', () => {
  it('formats day / hour / minute scale deadlines', () => {
    expect(formatCountdown(2 * 86_400_000 + 4 * 3_600_000)).toBe('2d 4h');
    expect(formatCountdown(5 * 3_600_000 + 12 * 60_000)).toBe('5h 12m');
    expect(formatCountdown(18 * 60_000)).toBe('18m');
    expect(formatCountdown(0)).toBe('gone');
  });
});

describe('recentLabelChips', () => {
  function annotation(id: number, time: string, label: string | null): AnnotationRow {
    return { id, time, endTime: null, category: 'appliance', label, notes: null, source: 'manual', createdAt: time };
  }

  it('de-duplicates, drops blanks, orders newest first and caps', () => {
    const chips = recentLabelChips(
      [
        annotation(1, '2026-01-01T10:00:00Z', 'microwave'),
        annotation(2, '2026-01-01T11:00:00Z', '  '),
        annotation(3, '2026-01-01T12:00:00Z', 'kettle'),
        annotation(4, '2026-01-01T13:00:00Z', 'microwave'),
        annotation(5, '2026-01-01T14:00:00Z', null),
        annotation(6, '2026-01-01T15:00:00Z', 'washing machine'),
      ],
      2,
    );
    expect(chips).toEqual(['washing machine', 'microwave']);
  });
});

describe('annotationReviewWindow', () => {
  it('uses an interval annotation\'s own span', () => {
    expect(
      annotationReviewWindow({ time: '2026-01-01T12:00:00Z', endTime: '2026-01-01T12:10:00Z' }, 150_000),
    ).toEqual({ fromMs: T('2026-01-01T12:00:00Z'), toMs: T('2026-01-01T12:10:00Z') });
  });

  it('pads a point annotation symmetrically rather than inventing a span', () => {
    expect(annotationReviewWindow({ time: '2026-01-01T12:00:00Z', endTime: null }, 150_000)).toEqual({
      fromMs: T('2026-01-01T11:57:30Z'),
      toMs: T('2026-01-01T12:02:30Z'),
    });
  });

  it('returns null for an unparseable time', () => {
    expect(annotationReviewWindow({ time: 'not-a-time', endTime: null }, 1000)).toBeNull();
  });
});

describe('deriveMissions', () => {
  const gap = (from: string, to: string): ExpiringGap => ({ from, to, reason: 'unreviewed' });
  const DAY = 86_400_000;

  it('orders most urgent (oldest newest-edge) first and computes the deadline', () => {
    const now = T('2026-01-08T00:00:00Z');
    const missions = deriveMissions(
      [gap('2026-01-01T06:00:00Z', '2026-01-01T07:00:00Z'), gap('2026-01-01T02:00:00Z', '2026-01-01T03:00:00Z')],
      7 * DAY,
      now,
    );
    expect(missions.map((m) => m.fromIso)).toEqual(['2026-01-01T02:00:00Z', '2026-01-01T06:00:00Z']);
    // 03:00 on the 1st + 7 days = 03:00 on the 8th -> 3h left at this `now`.
    expect(missions[0]?.msUntilGone).toBe(3 * 3_600_000);
    expect(missions[0]?.spanMs).toBe(3_600_000);
  });

  it('reports an unknown deadline as null rather than a comfortable-looking number', () => {
    const missions = deriveMissions([gap('2026-01-01T02:00:00Z', '2026-01-01T03:00:00Z')], null, T('2026-01-08T00:00:00Z'));
    expect(missions[0]?.msUntilGone).toBeNull();
  });

  it('drops stretches retention has already dropped, and malformed entries', () => {
    const now = T('2026-01-10T00:00:00Z');
    const missions = deriveMissions(
      [
        gap('2026-01-01T02:00:00Z', '2026-01-01T03:00:00Z'), // gone: 03:00 + 7d < now
        gap('2026-01-03T02:00:00Z', '2026-01-03T03:00:00Z'), // still saveable
        gap('2026-01-03T04:00:00Z', '2026-01-03T04:00:00Z'), // zero width
        gap('nope', '2026-01-03T05:00:00Z'), // unparseable
      ],
      7 * DAY,
      now,
    );
    expect(missions.map((m) => m.fromIso)).toEqual(['2026-01-03T02:00:00Z']);
  });
});

describe('isShortcutSuppressed', () => {
  const base = { tagName: 'BODY', isContentEditable: false, ctrlKey: false, metaKey: false, altKey: false };

  it('allows a bare key outside a form field', () => {
    expect(isShortcutSuppressed(base)).toBe(false);
    expect(isShortcutSuppressed({ ...base, tagName: 'BUTTON' })).toBe(false);
  });

  it('suppresses while typing in a text field or contenteditable', () => {
    expect(isShortcutSuppressed({ ...base, tagName: 'INPUT' })).toBe(true);
    expect(isShortcutSuppressed({ ...base, tagName: 'TEXTAREA' })).toBe(true);
    expect(isShortcutSuppressed({ ...base, tagName: 'SELECT' })).toBe(true);
    expect(isShortcutSuppressed({ ...base, isContentEditable: true })).toBe(true);
  });

  it('suppresses modifier chords so Ctrl+Z / Cmd+0 are not swallowed', () => {
    expect(isShortcutSuppressed({ ...base, ctrlKey: true })).toBe(true);
    expect(isShortcutSuppressed({ ...base, metaKey: true })).toBe(true);
    expect(isShortcutSuppressed({ ...base, altKey: true })).toBe(true);
  });
});
