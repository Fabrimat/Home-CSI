import { describe, expect, it } from 'vitest';
import { createInMemoryBoxSessionStore } from './sessions.js';

describe('createInMemoryBoxSessionStore', () => {
  it('creates a session with the given gesture class and optional fields defaulted to null', async () => {
    const store = createInMemoryBoxSessionStore();
    const session = await store.createSession({
      startedAtMs: 1000,
      gestureClass: 'fist',
      geometryNote: null,
      notes: null,
    });
    expect(session.id).toBe(1);
    expect(session.gestureClass).toBe('fist');
    expect(session.endedAtMs).toBeNull();
    expect(session.geometryNote).toBeNull();
    expect(session.notes).toBeNull();
  });

  it('stops a session, setting endedAtMs', async () => {
    const store = createInMemoryBoxSessionStore();
    const session = await store.createSession({ startedAtMs: 1000, gestureClass: 'fist', geometryNote: null, notes: null });
    const stopped = await store.stopSession(session.id, 2000);
    expect(stopped?.endedAtMs).toBe(2000);
  });

  it('stopSession returns null for a nonexistent id', async () => {
    const store = createInMemoryBoxSessionStore();
    expect(await store.stopSession(999, 2000)).toBeNull();
  });

  it('re-stopping an already-stopped session returns it UNCHANGED, not re-stamped with the new endedAtMs', async () => {
    const store = createInMemoryBoxSessionStore();
    const session = await store.createSession({ startedAtMs: 1000, gestureClass: 'fist', geometryNote: null, notes: null });
    const first = await store.stopSession(session.id, 2000);
    const second = await store.stopSession(session.id, 9999);

    expect(first?.endedAtMs).toBe(2000);
    expect(second?.endedAtMs).toBe(2000); // NOT 9999 -- moving the window after the fact would corrupt training data
    expect(second?.id).toBe(session.id);
  });

  it('lists sessions newest-started first', async () => {
    const store = createInMemoryBoxSessionStore();
    await store.createSession({ startedAtMs: 1000, gestureClass: 'a', geometryNote: null, notes: null });
    await store.createSession({ startedAtMs: 3000, gestureClass: 'b', geometryNote: null, notes: null });
    await store.createSession({ startedAtMs: 2000, gestureClass: 'c', geometryNote: null, notes: null });

    const sessions = await store.listSessions(10);
    expect(sessions.map((s) => s.gestureClass)).toEqual(['b', 'c', 'a']);
  });

  it('respects the limit', async () => {
    const store = createInMemoryBoxSessionStore();
    for (let i = 0; i < 5; i++) {
      await store.createSession({ startedAtMs: i, gestureClass: `g${i}`, geometryNote: null, notes: null });
    }
    expect(await store.listSessions(2)).toHaveLength(2);
  });

  it('getSession returns the session or null', async () => {
    const store = createInMemoryBoxSessionStore();
    const session = await store.createSession({ startedAtMs: 1000, gestureClass: 'fist', geometryNote: null, notes: null });
    expect(await store.getSession(session.id)).toEqual(session);
    expect(await store.getSession(999)).toBeNull();
  });

  it('deletes a session and reports whether one existed', async () => {
    const store = createInMemoryBoxSessionStore();
    const session = await store.createSession({ startedAtMs: 1000, gestureClass: 'fist', geometryNote: null, notes: null });
    expect(await store.deleteSession(session.id)).toBe(true);
    expect(await store.getSession(session.id)).toBeNull();
    expect(await store.deleteSession(session.id)).toBe(false);
  });
});
