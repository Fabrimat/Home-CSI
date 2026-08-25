import { describe, expect, it } from 'vitest';
import {
  buildPlacementYaml,
  classifyLinksForFloor,
  computeFloorExtent,
  computeFloorTransform,
  computeMotionColorScale,
  distinctFloors,
  effectivePosition,
  explainMissingGeometry,
  findZoneFor,
  metresToPixels,
  motionColorT,
  niceScaleBarLengthM,
  parsePositionInput,
  pixelsToMetres,
  roundPlacement,
  topologyChanged,
  type HouseMapLink,
  type HouseMapNode,
  type HouseMapZone,
} from './houseMapGeometry.js';

function node(overrides: Partial<HouseMapNode> & Pick<HouseMapNode, 'id' | 'name'>): HouseMapNode {
  return { room: 'room', floor: 0, position: null, ...overrides };
}

function motion(meanAbsDeviation: number, motionActive = false): HouseMapLink['motion'] {
  return { meanAbsDeviation, motionActive, sampleCount: 10, lastSeenAt: '2026-01-01T00:00:00.000Z' };
}

describe('distinctFloors', () => {
  it('dedupes and sorts ascending, including negative (basement) floors', () => {
    const nodes = [node({ id: 1, name: 'a', floor: 0 }), node({ id: 2, name: 'b', floor: -1 }), node({ id: 3, name: 'c', floor: 1 }), node({ id: 4, name: 'd', floor: 0 })];
    expect(distinctFloors(nodes)).toEqual([-1, 0, 1]);
  });

  it('still reports the default floor for entirely unplaced nodes', () => {
    expect(distinctFloors([node({ id: 1, name: 'a' })])).toEqual([0]);
  });
});

describe('computeFloorExtent', () => {
  it('returns null for zero placed nodes -- never a fabricated (0,0)-centred box', () => {
    expect(computeFloorExtent([])).toBeNull();
  });

  it('produces a non-zero, centred box for a single placed node', () => {
    const extent = computeFloorExtent([{ x: 5, y: 5 }])!;
    expect(extent).not.toBeNull();
    expect(extent.widthM).toBeGreaterThan(0);
    expect(extent.heightM).toBeGreaterThan(0);
    // Centred on the single point.
    expect((extent.minX + extent.maxX) / 2).toBeCloseTo(5);
    expect((extent.minY + extent.maxY) / 2).toBeCloseTo(5);
  });

  it('fits multiple placed nodes with padding beyond their raw bounding box', () => {
    const extent = computeFloorExtent([
      { x: 0, y: 0 },
      { x: 10, y: 4 },
    ])!;
    expect(extent.minX).toBeLessThan(0);
    expect(extent.maxX).toBeGreaterThan(10);
    expect(extent.minY).toBeLessThan(0);
    expect(extent.maxY).toBeGreaterThan(4);
  });

  it('handles two nodes stacked at identical coordinates (zero raw extent) the same as a single point', () => {
    // Guards the MIN_SPAN_M floor against a future edit: a naive
    // `maxX - minX` span here is 0 in BOTH axes, same as the single-point
    // case above, and must not produce a zero-width/height viewport.
    const extent = computeFloorExtent([
      { x: 3, y: -2 },
      { x: 3, y: -2 },
    ])!;
    expect(extent).not.toBeNull();
    expect(extent.widthM).toBeGreaterThan(0);
    expect(extent.heightM).toBeGreaterThan(0);
    expect((extent.minX + extent.maxX) / 2).toBeCloseTo(3);
    expect((extent.minY + extent.maxY) / 2).toBeCloseTo(-2);
  });
});

describe('computeFloorTransform / metresToPixels / pixelsToMetres', () => {
  it('round-trips a metre point through pixel space', () => {
    const extent = computeFloorExtent([
      { x: -2, y: 1 },
      { x: 8, y: 6 },
    ])!;
    const transform = computeFloorTransform(extent, 900, 500);
    const original = { x: 3.4, y: 2.1 };
    const px = metresToPixels(original, extent, transform);
    const back = pixelsToMetres(px, extent, transform);
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
  });

  it('uses a uniform scale (never independently stretches x vs y)', () => {
    const extent = computeFloorExtent([
      { x: 0, y: 0 },
      { x: 20, y: 2 },
    ])!;
    const transform = computeFloorTransform(extent, 900, 500);
    // Scale is bound by whichever axis is tighter (width here, given a wide floor and modest pixel height).
    expect(transform.scale).toBeCloseTo(Math.min(900 / extent.widthM, 500 / extent.heightM));
  });
});

describe('niceScaleBarLengthM', () => {
  it('picks a round step near a quarter of the floor width', () => {
    expect(niceScaleBarLengthM(4)).toBe(1);
    expect(niceScaleBarLengthM(40)).toBe(10);
  });

  it('never returns something larger than the smallest step for a tiny floor', () => {
    expect(niceScaleBarLengthM(0.1)).toBe(0.5);
  });
});

describe('computeMotionColorScale / motionColorT', () => {
  it('defaults to a neutral [0,1] scale when there is no data', () => {
    expect(computeMotionColorScale([])).toEqual({ min: 0, max: 1 });
  });

  it('clips at the 95th percentile so one outlier link does not wash out the rest', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    values.push(1000); // outlier
    const scale = computeMotionColorScale(values);
    expect(scale.min).toBe(0);
    expect(scale.max).toBeLessThan(100); // nowhere near the outlier
    expect(scale.max).toBeGreaterThan(15);
  });

  it('clamps t to [0,1], saturating above max rather than going out of range', () => {
    const scale = { min: 0, max: 10 };
    expect(motionColorT(-5, scale)).toBe(0);
    expect(motionColorT(5, scale)).toBe(0.5);
    expect(motionColorT(50, scale)).toBe(1);
  });

  it('never divides by zero when max <= min', () => {
    expect(motionColorT(5, { min: 0, max: 0 })).toBe(0);
  });
});

describe('findZoneFor', () => {
  const zones: HouseMapZone[] = [{ room: 'kitchen', floor: 0, linkCount: 2, meanAbsDeviation: 1.2, motionActive: true }];
  it('matches by room AND floor, not room alone', () => {
    expect(findZoneFor(zones, 'kitchen', 0)).toEqual(zones[0]);
    expect(findZoneFor(zones, 'kitchen', 1)).toBeNull();
    expect(findZoneFor(zones, 'hallway', 0)).toBeNull();
  });
});

describe('explainMissingGeometry', () => {
  const kitchenNode = node({ id: 1, name: 'kitchen-node', room: 'kitchen', floor: 0, position: { x: 0, y: 0 } });
  const unplacedNode = node({ id: 2, name: 'hallway-node', room: 'hallway', floor: 0, position: null });
  const nodesById = new Map([
    [1, kitchenNode],
    [2, unplacedNode],
  ]);

  it('reports an unresolved peer MAC distinctly from a missing position', () => {
    const link: HouseMapLink = { nodeId: 1, linkMac: 'aa:bb:cc:dd:ee:ff', peerNodeId: null, geometry: null, motion: motion(0.5) };
    expect(explainMissingGeometry(link, nodesById)).toContain('aa:bb:cc:dd:ee:ff');
  });

  it('names the endpoint missing a configured position', () => {
    const link: HouseMapLink = { nodeId: 1, linkMac: 'aa:bb:cc:dd:ee:ff', peerNodeId: 2, geometry: null, motion: motion(0.5) };
    const reason = explainMissingGeometry(link, nodesById);
    expect(reason).toContain('hallway-node');
    expect(reason).toContain('no configured position');
  });
});

describe('classifyLinksForFloor', () => {
  const groundNodeA = node({ id: 1, name: 'A', room: 'kitchen', floor: 0, position: { x: 0, y: 0 } });
  const groundNodeB = node({ id: 2, name: 'B', room: 'hallway', floor: 0, position: { x: 5, y: 0 } });
  const upstairsNode = node({ id: 3, name: 'C', room: 'bedroom', floor: 1, position: { x: 0, y: 0 } });
  const unplacedGroundNode = node({ id: 4, name: 'D', room: 'garage', floor: 0, position: null });
  const nodesById = new Map([
    [1, groundNodeA],
    [2, groundNodeB],
    [3, upstairsNode],
    [4, unplacedGroundNode],
  ]);

  const sameFloorGeom = { from: { x: 0, y: 0 }, to: { x: 5, y: 0 }, midpoint: { x: 2.5, y: 0 }, lengthM: 5, sameFloor: true, rooms: ['kitchen', 'hallway'] as [string, string] };
  const crossFloorGeom = { from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, midpoint: { x: 0, y: 0 }, lengthM: 0, sameFloor: false, rooms: ['kitchen', 'bedroom'] as [string, string] };

  const links: HouseMapLink[] = [
    { nodeId: 1, linkMac: 'mac-drawable', peerNodeId: 2, geometry: sameFloorGeom, motion: motion(1) },
    { nodeId: 1, linkMac: 'mac-cross', peerNodeId: 3, geometry: crossFloorGeom, motion: motion(2) },
    { nodeId: 1, linkMac: 'mac-unresolved-peer', peerNodeId: null, geometry: null, motion: motion(0.1) },
    { nodeId: 4, linkMac: 'mac-unplaced-observer', peerNodeId: 2, geometry: null, motion: motion(0.3) },
    { nodeId: 3, linkMac: 'mac-other-floor', peerNodeId: 1, geometry: crossFloorGeom, motion: motion(0.4) },
  ];

  it('buckets links owned by the given floor into drawable/crossFloor/unresolved', () => {
    const buckets = classifyLinksForFloor(links, nodesById, 0);
    expect(buckets.drawable.map((l) => l.linkMac)).toEqual(['mac-drawable']);
    expect(buckets.crossFloor.map((l) => l.link.linkMac)).toEqual(['mac-cross']);
    expect(buckets.crossFloor[0]?.peerFloor).toBe(1);
    expect(buckets.unresolved.map((u) => u.link.linkMac).sort()).toEqual(['mac-unplaced-observer', 'mac-unresolved-peer']);
  });

  it('does not duplicate a link into a floor it does not belong to', () => {
    const buckets = classifyLinksForFloor(links, nodesById, 0);
    expect(buckets.drawable.some((l) => l.linkMac === 'mac-other-floor')).toBe(false);
    expect(buckets.crossFloor.some((c) => c.link.linkMac === 'mac-other-floor')).toBe(false);
  });

  it('lists a link owned by floor 1 only under floor 1', () => {
    const buckets = classifyLinksForFloor(links, nodesById, 1);
    expect(buckets.crossFloor.map((c) => c.link.linkMac)).toEqual(['mac-other-floor']);
  });
});

describe('effectivePosition', () => {
  it('prefers a pending override over the real position', () => {
    const n = node({ id: 1, name: 'a', position: { x: 1, y: 1 } });
    const pending = new Map([[1, { x: 9, y: 9 }]]);
    expect(effectivePosition(n, pending)).toEqual({ x: 9, y: 9 });
  });

  it('falls back to the real (possibly null) position with no override', () => {
    const placed = node({ id: 1, name: 'a', position: { x: 1, y: 1 } });
    const unplaced = node({ id: 2, name: 'b', position: null });
    expect(effectivePosition(placed, new Map())).toEqual({ x: 1, y: 1 });
    expect(effectivePosition(unplaced, new Map())).toBeNull();
  });
});

describe('roundPlacement / buildPlacementYaml', () => {
  it('rounds to centimetre precision', () => {
    expect(roundPlacement({ x: 1.23456, y: -0.001 })).toEqual({ x: 1.23, y: 0 });
  });

  it('emits floor/position in nodeSchema shape, with no id/name/room/psk fields to blindly overwrite', () => {
    const yaml = buildPlacementYaml({ id: 7, name: 'Kitchen node', room: 'kitchen' }, 1, { x: 2.345, y: -1.1 });
    expect(yaml).toBe(['# Kitchen node (id 7, room "kitchen") -- merge into its entry under nodes: in config.yaml', 'floor: 1', 'position:', '  x: 2.35', '  y: -1.1'].join('\n'));
    expect(yaml).not.toContain('psk');
  });
});

describe('parsePositionInput', () => {
  it('rejects a blank field rather than treating it as 0 -- Number("") is 0, not NaN', () => {
    expect(parsePositionInput('', '1')).toBeNull();
    expect(parsePositionInput('1', '')).toBeNull();
    expect(parsePositionInput('', '')).toBeNull();
  });

  it('rejects a whitespace-only field the same way', () => {
    expect(parsePositionInput('   ', '1')).toBeNull();
    expect(parsePositionInput('1', '\t')).toBeNull();
  });

  it('rejects non-numeric text', () => {
    expect(parsePositionInput('abc', '1')).toBeNull();
    expect(parsePositionInput('1', 'abc')).toBeNull();
  });

  it('rejects a bare minus sign (incomplete negative number)', () => {
    expect(parsePositionInput('-', '1')).toBeNull();
  });

  it('rejects an overflowing exponent that parses to Infinity, not a finite number', () => {
    expect(parsePositionInput('1e999', '1')).toBeNull();
  });

  it('accepts a valid negative coordinate', () => {
    expect(parsePositionInput('-3.5', '2')).toEqual({ x: -3.5, y: 2 });
  });

  it('accepts a valid decimal pair', () => {
    expect(parsePositionInput('2.35', '-1.1')).toEqual({ x: 2.35, y: -1.1 });
  });
});

describe('topologyChanged', () => {
  const n1 = node({ id: 1, name: 'kitchen-node', room: 'kitchen', floor: 0, position: { x: 0, y: 0 } });
  const n2 = node({ id: 2, name: 'hallway-node', room: 'hallway', floor: 0, position: { x: 5, y: 0 } });
  const geometry = { from: { x: 0, y: 0 }, to: { x: 5, y: 0 }, midpoint: { x: 2.5, y: 0 }, lengthM: 5, sameFloor: true, rooms: ['kitchen', 'hallway'] as [string, string] };
  const link: HouseMapLink = { nodeId: 1, linkMac: 'aa:bb:cc:dd:ee:ff', peerNodeId: 2, geometry, motion: motion(1.2, false) };
  const zone: HouseMapZone = { room: 'kitchen', floor: 0, linkCount: 1, meanAbsDeviation: 1.2, motionActive: false };

  function snapshot(overrides: { link?: HouseMapLink; zone?: HouseMapZone } = {}): { nodes: HouseMapNode[]; links: HouseMapLink[]; zones: HouseMapZone[] } {
    return { nodes: [n1, n2], links: [overrides.link ?? link], zones: [overrides.zone ?? zone] };
  }

  it('always reports changed when there is no previous snapshot yet', () => {
    expect(topologyChanged(null, snapshot())).toBe(true);
  });

  it('reports unchanged for an identical payload', () => {
    expect(topologyChanged(snapshot(), snapshot())).toBe(false);
  });

  it('reports changed when a link motion value differs', () => {
    const next = snapshot({ link: { ...link, motion: motion(3.4, false) } });
    expect(topologyChanged(snapshot(), next)).toBe(true);
  });

  it('reports changed when motionActive flips', () => {
    const next = snapshot({ link: { ...link, motion: motion(1.2, true) } });
    expect(topologyChanged(snapshot(), next)).toBe(true);
  });

  it('reports changed when the node set differs (a node added)', () => {
    const previous = snapshot();
    const next = { ...snapshot(), nodes: [...previous.nodes, node({ id: 3, name: 'new-node', floor: 0 })] };
    expect(topologyChanged(previous, next)).toBe(true);
  });

  it('reports changed when a zone reading differs', () => {
    const next = snapshot({ zone: { ...zone, meanAbsDeviation: 5, motionActive: true } });
    expect(topologyChanged(snapshot(), next)).toBe(true);
  });

  it('does NOT report changed when only motion.lastSeenAt advances -- that alone must not tear down the level editor on every poll', () => {
    const previous = snapshot();
    const next = snapshot({ link: { ...link, motion: { ...link.motion, lastSeenAt: '2026-01-01T00:05:00.000Z' } } });
    expect(topologyChanged(previous, next)).toBe(false);
  });
});
