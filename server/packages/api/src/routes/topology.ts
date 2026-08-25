import type { FastifyInstance } from 'fastify';
import type { HomeCsiDb, NodeLiveness, NodePosition } from '../db/types.js';
import { boundedLimit, timeOrderCheck, TIME_ORDER_MESSAGE, timeRangeQuerySchema } from '../schemas.js';
import { parseOrThrow } from '../validate.js';

const MAX_TOPOLOGY_LINKS_LIMIT = 500;
const DEFAULT_TOPOLOGY_LINKS_LIMIT = 200;

const topologyQuerySchema = timeRangeQuerySchema
  .extend({ limit: boundedLimit(DEFAULT_TOPOLOGY_LINKS_LIMIT, MAX_TOPOLOGY_LINKS_LIMIT) })
  .refine(timeOrderCheck, { message: TIME_ORDER_MESSAGE });

export interface TopologyNode {
  id: number;
  name: string;
  room: string;
  floor: number;
  position: NodePosition | null;
}

export interface TopologyLinkGeometry {
  from: NodePosition;
  to: NodePosition;
  midpoint: NodePosition;
  lengthM: number;
  sameFloor: boolean;
  rooms: [string, string];
}

export interface TopologyLinkMotion {
  /** Mean of |feature_vector.baselineDeviation| across every window in range for this link (see @homecsi/features baseline.ts) -- baseline-relative standard-deviation units, comparable across links. NOT an amplitude, distance, or person count. */
  meanAbsDeviation: number;
  /** feature_vector.baselineFrozen of the most recent window in range. */
  motionActive: boolean;
  sampleCount: number;
  lastSeenAt: string;
}

export interface TopologyLink {
  /** The observing node. */
  nodeId: number;
  /** The transmitting peer's MAC, as captured. */
  linkMac: string;
  /** The peer's node id, when `linkMac` resolves to a configured node's `expectedMac`. `null` is normal (unresolved peer), not an error -- never dropped or guessed. */
  peerNodeId: number | null;
  /** `null` whenever the peer is unresolved or either endpoint lacks a placed position -- never a fabricated coordinate. */
  geometry: TopologyLinkGeometry | null;
  motion: TopologyLinkMotion;
}

export interface TopologyZone {
  room: string;
  floor: number;
  /**
   * Number of resolved-geometry link OBSERVATIONS contributing to this zone.
   * Two things this deliberately is not:
   *
   * - It is not deduplicated across directions. `features` is keyed
   *   `(time, node_id, link_mac)`, so node A observing B and node B
   *   observing A are two separate links here and both contribute. That is
   *   intended -- they are two independent measurements of the same path,
   *   not one measurement counted twice -- but it means a fully reciprocal
   *   mesh reports roughly double the node-pair count.
   * - It is not inflated by a link whose two endpoints share this very
   *   room+floor: that contributes once, not twice (see `zoneKey` and its
   *   use below).
   */
  linkCount: number;
  meanAbsDeviation: number;
  motionActive: boolean;
}

export interface TopologyResponse {
  nodes: TopologyNode[];
  links: TopologyLink[];
  zones: TopologyZone[];
  /**
   * Runtime-visible restatement of the honesty constraint, not just a
   * source comment: `zones` is link-path motion attribution aggregated per
   * room/floor from links whose geometry resolved, NOT a person count and
   * NOT a position estimate (docs/architecture.md "Motion, not people",
   * "Amplitude-first"). Any dashboard rendering `zones` must not present it
   * as either.
   */
  zoneSemantics: string;
}

const ZONE_SEMANTICS =
  'Per-room/floor aggregate of link-path motion deviation (feature_vector.baselineDeviation) from links whose geometry resolved. This is NOT a person count or position estimate -- CSI senses motion on a link, not where a person is.';

function distanceM(a: NodePosition, b: NodePosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface ZoneAccumulator {
  room: string;
  floor: number;
  deviationSum: number;
  count: number;
  active: boolean;
}

/** The zone accumulator key for a node -- single source of truth so the dedup check below and `addZoneContribution` can never drift apart. */
function zoneKey(node: NodeLiveness): string {
  return `${node.room}::${node.floor}`;
}

/**
 * Turns per-node placement (packages/config's `nodeSchema`; storage added by
 * migration 010) plus the per-link motion signal @homecsi/features already
 * computes into a floor-plan-ready view: which links were actually observed
 * over the window, their geometry when both endpoints are known, and motion
 * aggregated per room/floor "zone".
 *
 * HONESTY CONSTRAINT (docs/architecture.md "Amplitude-first", "Motion, not
 * people" -- read those before changing this file): this system cannot
 * localise a person. ESP32 CSI phase has no hardware TX/RX lock and is not
 * corrected for CFO/SFO, so nothing here may depend on phase, AoA, ToF, or
 * trilateration, and nothing here computes or returns a person position or
 * a per-zone person count. What this endpoint legitimately provides is
 * LINK-path motion attribution: "the link between the kitchen and hallway
 * nodes shows motion" is a defensible, data-backed statement about a
 * region, derived entirely from amplitude and each node's own declared
 * (config-sourced) position. `geometry` is `null`, never fabricated,
 * whenever a link's peer is unresolved or either endpoint lacks a placed
 * position -- the UI must be able to render with `geometry: null`.
 */
export function registerTopologyRoutes(app: FastifyInstance, db: HomeCsiDb): void {
  app.get('/api/topology', async (request) => {
    const { from, to, limit } = parseOrThrow(topologyQuerySchema, request.query);

    const [nodeRows, linkMotion] = await Promise.all([
      db.listNodes(),
      db.listLinkMotion({ from, to, limit }),
    ]);

    const nodesById = new Map<number, NodeLiveness>(nodeRows.map((n) => [n.id, n]));
    const nodeByMac = new Map<string, NodeLiveness>(
      nodeRows
        .filter((n): n is NodeLiveness & { expectedMac: string } => n.expectedMac !== null)
        .map((n) => [n.expectedMac.toLowerCase(), n]),
    );

    const zoneAgg = new Map<string, ZoneAccumulator>();
    function addZoneContribution(node: NodeLiveness, meanAbsDeviation: number, active: boolean): void {
      const key = zoneKey(node);
      const existing = zoneAgg.get(key) ?? { room: node.room, floor: node.floor, deviationSum: 0, count: 0, active: false };
      existing.deviationSum += meanAbsDeviation;
      existing.count += 1;
      existing.active = existing.active || active;
      zoneAgg.set(key, existing);
    }

    const links: TopologyLink[] = linkMotion.map((lm) => {
      const fromNode = nodesById.get(lm.nodeId) ?? null;
      const peerNode = nodeByMac.get(lm.linkMac.toLowerCase()) ?? null;

      let geometry: TopologyLinkGeometry | null = null;
      if (fromNode?.position && peerNode?.position) {
        const from = fromNode.position;
        const to = peerNode.position;
        geometry = {
          from,
          to,
          midpoint: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
          lengthM: distanceM(from, to),
          sameFloor: fromNode.floor === peerNode.floor,
          rooms: [fromNode.room, peerNode.room],
        };
        // A single link contributes to a given zone AT MOST ONCE: two nodes
        // sharing a room+floor (a normal deployment -- coverage redundancy
        // in one large room) would otherwise double-count that one link's
        // deviation into the zone average and its linkCount.
        addZoneContribution(fromNode, lm.meanAbsDeviation, lm.motionActive);
        if (zoneKey(peerNode) !== zoneKey(fromNode)) {
          addZoneContribution(peerNode, lm.meanAbsDeviation, lm.motionActive);
        }
      }

      return {
        nodeId: lm.nodeId,
        linkMac: lm.linkMac,
        peerNodeId: peerNode ? peerNode.id : null,
        geometry,
        motion: {
          meanAbsDeviation: lm.meanAbsDeviation,
          motionActive: lm.motionActive,
          sampleCount: lm.sampleCount,
          lastSeenAt: lm.lastSeenAt,
        },
      };
    });

    const zones: TopologyZone[] = [...zoneAgg.values()].map((z) => ({
      room: z.room,
      floor: z.floor,
      linkCount: z.count,
      meanAbsDeviation: z.deviationSum / z.count,
      motionActive: z.active,
    }));

    const nodes: TopologyNode[] = nodeRows.map((n) => ({
      id: n.id,
      name: n.name,
      room: n.room,
      floor: n.floor,
      position: n.position,
    }));

    const response: TopologyResponse = { nodes, links, zones, zoneSemantics: ZONE_SEMANTICS };
    return response;
  });
}
