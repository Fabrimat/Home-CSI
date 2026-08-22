import { describe, expect, it } from 'vitest';
import { WEAK_LABEL_PREFIX, createInMemoryLabelStore, isWeakLabel, stripWeakPrefix } from './sessions.js';

describe('WEAK_LABEL_PREFIX conventions', () => {
  it('isWeakLabel recognises the prefix and rejects manual notes', () => {
    expect(isWeakLabel(`${WEAK_LABEL_PREFIX} devices=alice-phone`)).toBe(true);
    expect(isWeakLabel('manual: saw two people arrive')).toBe(false);
    expect(isWeakLabel(null)).toBe(false);
  });

  it('stripWeakPrefix removes the prefix, leaves manual notes untouched', () => {
    expect(stripWeakPrefix(`${WEAK_LABEL_PREFIX} devices=alice-phone`)).toBe('devices=alice-phone');
    expect(stripWeakPrefix('manual note')).toBe('manual note');
    expect(stripWeakPrefix(null)).toBe('');
  });
});

describe('createInMemoryLabelStore', () => {
  it('creates and lists sessions', async () => {
    const store = createInMemoryLabelStore();
    const session = await store.createSession(1000, 'test session');
    expect(session.id).toBeGreaterThan(0);
    expect(session.endedAtMs).toBeNull();

    const all = await store.listSessions();
    expect(all).toHaveLength(1);
    expect(all[0]!.notes).toBe('test session');
  });

  it('getOpenSession returns the most recent session with no end time', async () => {
    const store = createInMemoryLabelStore();
    expect(await store.getOpenSession()).toBeNull();

    const first = await store.createSession(1000, null);
    await store.stopSession(first.id, 2000);
    expect(await store.getOpenSession()).toBeNull();

    const second = await store.createSession(3000, null);
    const open = await store.getOpenSession();
    expect(open?.id).toBe(second.id);
  });

  it('stopSession sets endedAtMs and throws for an unknown session', async () => {
    const store = createInMemoryLabelStore();
    const session = await store.createSession(1000, null);
    const stopped = await store.stopSession(session.id, 5000);
    expect(stopped.endedAtMs).toBe(5000);

    await expect(store.stopSession(999, 1)).rejects.toThrow(/no label_session/);
  });

  it('adds and lists labels, filtered by session when requested', async () => {
    const store = createInMemoryLabelStore();
    const sessionA = await store.createSession(0, null);
    const sessionB = await store.createSession(0, null);
    await store.addLabel(sessionA.id, 100, 1, 'manual');
    await store.addLabel(sessionB.id, 200, 2, `${WEAK_LABEL_PREFIX} devices=x`);

    const all = await store.listLabels();
    expect(all).toHaveLength(2);

    const onlyA = await store.listLabels(sessionA.id);
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]!.occupancyCount).toBe(1);
  });

  it('labels are returned ordered by time ascending', async () => {
    const store = createInMemoryLabelStore();
    const session = await store.createSession(0, null);
    await store.addLabel(session.id, 2000, 1, null);
    await store.addLabel(session.id, 1000, 1, null);
    const labels = await store.listLabels(session.id);
    expect(labels.map((l) => l.timeMs)).toEqual([1000, 2000]);
  });
});
