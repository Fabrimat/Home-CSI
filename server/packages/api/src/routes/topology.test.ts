import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';
import type { NodeLiveness } from '../db/types.js';
import type { TopologyLink, TopologyNode, TopologyZone } from './topology.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '__no-such-web-assets-dir__');

function authHeader() {
  return { authorization: `Bearer ${API_TOKEN}` };
}

function makeApp(db = new FakeHomeCsiDb()) {
  return { app: buildApp({ db, apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR }), db };
}

function node(overrides: Partial<NodeLiveness> & Pick<NodeLiveness, 'id' | 'name' | 'room'>): NodeLiveness {
  return {
    expectedMac: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastHeartbeatAt: null,
    lastCsiRecordAt: null,
    floor: 0,
    position: null,
    ...overrides,
  };
}

describe('GET /api/topology', () => {
  it('resolves link geometry only when the peer is a known, placed node -- never dropping or fabricating an unresolved/unplaced link', async () => {
    const db = new FakeHomeCsiDb();
    db.nodes = [
      node({ id: 1, name: 'node-kitchen', room: 'kitchen', floor: 0, position: { x: 0, y: 0 }, expectedMac: 'aa:aa:aa:aa:aa:01' }),
      node({ id: 2, name: 'node-hall', room: 'hallway', floor: 0, position: { x: 3, y: 4 }, expectedMac: 'aa:aa:aa:aa:aa:02' }),
      node({ id: 3, name: 'node-upstairs', room: 'bedroom', floor: 1, position: null, expectedMac: 'aa:aa:aa:aa:aa:03' }),
    ];
    db.features = [
      // Resolved link: node 1 hearing node 2's soundings, two windows.
      { time: '2026-01-01T00:00:01Z', nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:02', windowMs: 2000, featureVector: { baselineDeviation: 4, baselineFrozen: true } },
      { time: '2026-01-01T00:00:02Z', nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:02', windowMs: 2000, featureVector: { baselineDeviation: -2, baselineFrozen: false } },
      // Unresolved peer: link_mac isn't any configured node's expectedMac.
      { time: '2026-01-01T00:00:01Z', nodeId: 2, linkMac: 'de:ad:be:ef:00:01', windowMs: 2000, featureVector: { baselineDeviation: 1, baselineFrozen: false } },
      // Resolved peer (node 3), but node 3 has no placed position -> geometry null.
      { time: '2026-01-01T00:00:01Z', nodeId: 2, linkMac: 'aa:aa:aa:aa:aa:03', windowMs: 2000, featureVector: { baselineDeviation: 1, baselineFrozen: false } },
    ];

    const { app } = makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/topology?from=2026-01-01T00:00:00Z&to=2026-01-01T00:01:00Z',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      nodes: TopologyNode[];
      links: TopologyLink[];
      zones: TopologyZone[];
      zoneSemantics: string;
    };

    expect(body.nodes).toHaveLength(3);
    // The honesty statement explicitly disclaims person-counting/positioning
    // (it legitimately contains those words in a negation) -- assert it says
    // "not a ... position" rather than merely being absent of the words.
    expect(body.zoneSemantics).toMatch(/not .*position/i);

    const resolvedLink = body.links.find((l) => l.nodeId === 1 && l.linkMac === 'aa:aa:aa:aa:aa:02');
    expect(resolvedLink?.peerNodeId).toBe(2);
    expect(resolvedLink?.geometry).toEqual({
      from: { x: 0, y: 0 },
      to: { x: 3, y: 4 },
      midpoint: { x: 1.5, y: 2 },
      lengthM: 5,
      sameFloor: true,
      rooms: ['kitchen', 'hallway'],
    });
    expect(resolvedLink?.motion.meanAbsDeviation).toBe(3); // mean(|4|, |-2|)
    expect(resolvedLink?.motion.motionActive).toBe(false); // latest window (00:00:02) was not active

    const unresolvedLink = body.links.find((l) => l.linkMac === 'de:ad:be:ef:00:01');
    expect(unresolvedLink).toBeDefined();
    expect(unresolvedLink?.peerNodeId).toBeNull();
    expect(unresolvedLink?.geometry).toBeNull();

    const unplacedPeerLink = body.links.find((l) => l.linkMac === 'aa:aa:aa:aa:aa:03');
    expect(unplacedPeerLink?.peerNodeId).toBe(3);
    expect(unplacedPeerLink?.geometry).toBeNull();

    // Zones are derived ONLY from links whose geometry resolved.
    expect(body.zones.some((z) => z.room === 'bedroom')).toBe(false);
    const kitchenZone = body.zones.find((z) => z.room === 'kitchen' && z.floor === 0);
    expect(kitchenZone?.linkCount).toBe(1);
    expect(kitchenZone?.meanAbsDeviation).toBe(3);
    const hallwayZone = body.zones.find((z) => z.room === 'hallway' && z.floor === 0);
    expect(hallwayZone?.linkCount).toBe(1);
  });

  it('weights each link once toward a zone even when a link\'s two endpoints share that zone (same room+floor)', async () => {
    const db = new FakeHomeCsiDb();
    db.nodes = [
      // Two nodes in the SAME room+floor -- coverage redundancy in one big
      // room, a normal deployment shape, not exotic.
      node({ id: 1, name: 'node-a', room: 'bigroom', floor: 0, position: { x: 0, y: 0 }, expectedMac: 'aa:aa:aa:aa:aa:01' }),
      node({ id: 2, name: 'node-b', room: 'bigroom', floor: 0, position: { x: 1, y: 0 }, expectedMac: 'aa:aa:aa:aa:aa:02' }),
      node({ id: 3, name: 'node-c', room: 'other', floor: 0, position: { x: 5, y: 0 }, expectedMac: 'aa:aa:aa:aa:aa:03' }),
    ];
    db.features = [
      // L1: both endpoints (node 1, node 2) in "bigroom" -- deviation 10.
      { time: '2026-01-01T00:00:01Z', nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:02', windowMs: 2000, featureVector: { baselineDeviation: 10, baselineFrozen: false } },
      // L2: node 1 ("bigroom") <-> node 3 ("other") -- deviation 2.
      { time: '2026-01-01T00:00:01Z', nodeId: 1, linkMac: 'aa:aa:aa:aa:aa:03', windowMs: 2000, featureVector: { baselineDeviation: 2, baselineFrozen: false } },
    ];

    const { app } = makeApp(db);
    const res = await app.inject({
      method: 'GET',
      url: '/api/topology?from=2026-01-01T00:00:00Z&to=2026-01-01T00:01:00Z',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { zones: TopologyZone[] };

    // Weighting each link once: (10 + 2) / 2 = 6, over 2 distinct links --
    // NOT (10 + 10 + 2) / 3 = 7.33 from double-counting L1 via both of its
    // same-zone endpoints.
    const bigroomZone = body.zones.find((z) => z.room === 'bigroom' && z.floor === 0);
    expect(bigroomZone?.linkCount).toBe(2);
    expect(bigroomZone?.meanAbsDeviation).toBe(6);

    const otherZone = body.zones.find((z) => z.room === 'other' && z.floor === 0);
    expect(otherZone?.linkCount).toBe(1);
    expect(otherZone?.meanAbsDeviation).toBe(2);
  });

  it('rejects from >= to (shared timeRangeQuerySchema ordering check)', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/topology?from=2026-01-01T01:00:00Z&to=2026-01-01T00:00:00Z',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires auth like every other /api/* route', async () => {
    const { app } = makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/topology?from=2026-01-01T00:00:00Z&to=2026-01-01T00:01:00Z',
    });
    expect(res.statusCode).toBe(401);
  });
});
