/**
 * Pure, DOM-free geometry/scaling/normalisation logic backing the house map
 * view (views/houseMap.ts) -- unit-tested without a browser
 * (houseMapGeometry.test.ts), following labelRanges.ts/occupancySeries.ts's
 * precedent of keeping anything testable out of the DOM-touching view file.
 *
 * HONESTY CONSTRAINT (see CLAUDE.md "Amplitude-first", "Motion, not
 * people" and routes/topology.ts's own doc comment -- read both before
 * touching this file): this system cannot localise a person. Every
 * function here operates on a node's own declared (config-sourced) `{x, y}`
 * position, or a link's already-resolved endpoint-to-endpoint geometry
 * (computed server-side, trusted verbatim here) -- nothing here computes,
 * infers, or interpolates a person's position. `position: null` (not
 * placed) and `geometry: null` (unresolved peer, or an endpoint without a
 * placed position) are first-class states threaded through this whole
 * module: never coerced to `(0, 0)`, never silently dropped.
 */

export interface Point {
  x: number;
  y: number;
}

/** Mirrors `TopologyNode` (server/packages/api/src/routes/topology.ts). */
export interface HouseMapNode {
  id: number;
  name: string;
  room: string;
  floor: number;
  position: Point | null;
}

/** Mirrors `TopologyLinkGeometry`. */
export interface HouseMapLinkGeometry {
  from: Point;
  to: Point;
  midpoint: Point;
  lengthM: number;
  sameFloor: boolean;
  rooms: [string, string];
}

/** Mirrors `TopologyLinkMotion`. */
export interface HouseMapLinkMotion {
  meanAbsDeviation: number;
  motionActive: boolean;
  sampleCount: number;
  lastSeenAt: string;
}

/** Mirrors `TopologyLink`. */
export interface HouseMapLink {
  nodeId: number;
  linkMac: string;
  peerNodeId: number | null;
  geometry: HouseMapLinkGeometry | null;
  motion: HouseMapLinkMotion;
}

/** Mirrors `TopologyZone`. */
export interface HouseMapZone {
  room: string;
  floor: number;
  linkCount: number;
  meanAbsDeviation: number;
  motionActive: boolean;
}

/**
 * A structural subset of `GET /api/topology`'s response -- just enough to
 * decide whether the plan/tables/legend would draw anything differently.
 * `TopologyResponse` (views/houseMap.ts) has strictly more fields
 * (`zoneSemantics`) and is structurally assignable here as-is.
 */
export interface TopologySnapshot {
  nodes: HouseMapNode[];
  links: HouseMapLink[];
  zones: HouseMapZone[];
}

/** Strips the always-ticking `motion.lastSeenAt` (see `topologyChanged`'s comment) before a JSON-string comparison -- field order is fixed by this function itself on every call, so the comparison is stable across snapshots. */
function comparableSnapshot(t: TopologySnapshot): unknown {
  return {
    nodes: t.nodes.map((n) => ({ id: n.id, name: n.name, room: n.room, floor: n.floor, position: n.position })),
    links: t.links.map((l) => ({
      nodeId: l.nodeId,
      linkMac: l.linkMac,
      peerNodeId: l.peerNodeId,
      geometry: l.geometry,
      meanAbsDeviation: l.motion.meanAbsDeviation,
      motionActive: l.motion.motionActive,
      sampleCount: l.motion.sampleCount,
      // motion.lastSeenAt deliberately excluded -- see topologyChanged.
    })),
    zones: t.zones.map((z) => ({ room: z.room, floor: z.floor, linkCount: z.linkCount, meanAbsDeviation: z.meanAbsDeviation, motionActive: z.motionActive })),
  };
}

/**
 * True when anything the plan/tables/legend actually draw from differs
 * between two topology snapshots -- `null` for `previous` (nothing fetched
 * yet) always counts as changed. `motion.lastSeenAt` is deliberately
 * excluded from the comparison: the API bumps it forward on every poll
 * even when a link/zone's aggregated reading is otherwise byte-for-byte
 * identical (same window inputs, same deviation, same sample count), so
 * comparing it would make this predicate true on every single call and
 * defeat its entire purpose.
 *
 * This exists so views/houseMap.ts's 5-second poll can skip re-rendering
 * (and thus tearing down the level editor's in-progress, uncommitted
 * typing/focus, and needlessly rebuilding an unchanged SVG) when nothing
 * meaningful changed -- see the guard in its `load()`. It deliberately does
 * NOT try to freeze the view indefinitely while a field is focused: if the
 * underlying motion genuinely changes, this returns `true` and the view
 * re-renders, because "show live motion" is the whole point of this page.
 */
export function topologyChanged(previous: TopologySnapshot | null, next: TopologySnapshot): boolean {
  if (previous === null) return true;
  return JSON.stringify(comparableSnapshot(previous)) !== JSON.stringify(comparableSnapshot(next));
}

// --- Floor grouping ----------------------------------------------------

/** Every distinct `floor` value present, ascending -- a node's `floor` always exists (packages/config's schema defaults it to 0) even when it has no `position` yet, so this covers unplaced nodes too. */
export function distinctFloors(nodes: readonly HouseMapNode[]): number[] {
  return [...new Set(nodes.map((n) => n.floor))].sort((a, b) => a - b);
}

// --- Viewport fit --------------------------------------------------------

export interface FloorExtent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  widthM: number;
  heightM: number;
}

/** A single placed node, or several stacked at one point, still needs a non-zero viewport to fit into -- without this floor a lone node would draw at a zero-width/height box and every derived scale would divide by zero. */
const MIN_SPAN_M = 1;
/** Padding as a fraction of the larger raw span, each side -- a fixed metre margin would be too tight for a 20m floor and absurdly loose for a 2m one; a fraction scales with the data instead of guessing a house size. */
const PADDING_FRACTION = 0.15;

/**
 * Bounding box of PLACED node positions only, with padding, centred on the
 * data itself -- never assumes a corner origin or a particular scale,
 * because config.yaml's origin is arbitrary and chosen per-floor by the
 * operator (packages/config/src/schema.ts positionSchema's comment).
 * Returns `null` when there are zero placed positions: the caller must
 * render an explicit "nothing placed yet" state, never fall back to a
 * fabricated `(0, 0)`-centred viewport.
 */
export function computeFloorExtent(positions: readonly Point[]): FloorExtent | null {
  if (positions.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of positions) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const rawWidth = maxX - minX;
  const rawHeight = maxY - minY;
  const pad = Math.max(rawWidth, rawHeight, MIN_SPAN_M) * PADDING_FRACTION;
  const widthM = Math.max(rawWidth, MIN_SPAN_M) + pad * 2;
  const heightM = Math.max(rawHeight, MIN_SPAN_M) + pad * 2;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    minX: centerX - widthM / 2,
    minY: centerY - heightM / 2,
    maxX: centerX + widthM / 2,
    maxY: centerY + heightM / 2,
    widthM,
    heightM,
  };
}

export interface FloorTransform {
  /** Pixels per metre -- uniform across x/y so distances and angles on screen stay proportional to the real, metre-valued layout (an independent x/y scale would visually skew the house). */
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Fits `extent` into a `pixelWidth`×`pixelHeight` box at a uniform scale, centred (letterboxed on whichever axis has spare room). */
export function computeFloorTransform(extent: FloorExtent, pixelWidth: number, pixelHeight: number): FloorTransform {
  const scale = Math.min(pixelWidth / extent.widthM, pixelHeight / extent.heightM);
  const drawnWidth = extent.widthM * scale;
  const drawnHeight = extent.heightM * scale;
  return {
    scale,
    offsetX: (pixelWidth - drawnWidth) / 2,
    offsetY: (pixelHeight - drawnHeight) / 2,
  };
}

/**
 * Metres -> pixel coordinates within this floor's fitted viewport. Pixel y
 * increases downward (standard screen/SVG convention) -- this is a fixed
 * drawing convention, not a claim about compass direction: the metre axes'
 * orientation is itself an arbitrary, per-floor operator choice
 * (positionSchema's comment), so there is no "true north" to preserve or
 * violate here.
 */
export function metresToPixels(p: Point, extent: FloorExtent, transform: FloorTransform): Point {
  return {
    x: transform.offsetX + (p.x - extent.minX) * transform.scale,
    y: transform.offsetY + (p.y - extent.minY) * transform.scale,
  };
}

/** Inverse of `metresToPixels` -- turns a drag's pointer position (in the SVG's own coordinate space) back into a metre position for the level editor. */
export function pixelsToMetres(px: Point, extent: FloorExtent, transform: FloorTransform): Point {
  return {
    x: extent.minX + (px.x - transform.offsetX) / transform.scale,
    y: extent.minY + (px.y - transform.offsetY) / transform.scale,
  };
}

const NICE_SCALE_STEPS_M = [0.5, 1, 2, 5, 10, 20, 50, 100];

/** Picks a round metre length for the scale-bar reference, targeting roughly a quarter of the floor's own drawn width -- a fixed set of "nice" numbers reads better on a ruler than an exact, ugly fraction. */
export function niceScaleBarLengthM(widthM: number): number {
  const target = widthM / 4;
  let best = NICE_SCALE_STEPS_M[0] as number;
  for (const step of NICE_SCALE_STEPS_M) {
    if (step <= target) best = step;
  }
  return best;
}

// --- Colour scale ----------------------------------------------------------

export interface MotionColorScale {
  min: number;
  max: number;
}

const COLOR_SCALE_PERCENTILE = 0.95;

/**
 * `meanAbsDeviation` is baseline-relative and deliberately comparable
 * across links (routes/topology.ts's own doc comment), but it is
 * unbounded, so a literal min/max would let one noisy link wash out the
 * colour range for every other link on the plan. Clipped at the 95th
 * percentile of the CURRENTLY DISPLAYED values -- the same "robust range"
 * idea as waterfall.ts's `robustRange` -- rather than a hardcoded absolute
 * ceiling that would silently stop meaning anything as a deployment's
 * baseline drifts over months. `min` is always 0: `meanAbsDeviation` is a
 * mean of absolute values (routes/topology.ts), so it can never be
 * negative -- there is no "cold" below zero to show.
 */
export function computeMotionColorScale(values: readonly number[]): MotionColorScale {
  if (values.length === 0) return { min: 0, max: 1 };
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * COLOR_SCALE_PERCENTILE) - 1));
  const max = sorted[idx] as number;
  return { min: 0, max: max > 0 ? max : 1 };
}

/** Maps a raw `meanAbsDeviation` value to `t` in `[0, 1]` against `scale`, clamped -- a value above the percentile-clipped `max` renders fully saturated rather than off-scale or clipped to invisible. */
export function motionColorT(value: number, scale: MotionColorScale): number {
  if (scale.max <= scale.min) return 0;
  return Math.min(1, Math.max(0, (value - scale.min) / (scale.max - scale.min)));
}

// --- Zone lookup -------------------------------------------------------

/** Zones are keyed by (room, floor) -- the same grouping `routes/topology.ts` aggregates by -- never by node, since several nodes can share a room and therefore the same zone reading. */
export function findZoneFor(zones: readonly HouseMapZone[], room: string, floor: number): HouseMapZone | null {
  return zones.find((z) => z.room === room && z.floor === floor) ?? null;
}

// --- Link classification, per floor --------------------------------------

export type DrawableLink = HouseMapLink & { geometry: HouseMapLinkGeometry };

export interface UnresolvedLinkInfo {
  link: HouseMapLink;
  /** Why this link cannot be drawn -- surfaced to the operator, never silently dropped. */
  reason: string;
}

export interface CrossFloorLinkInfo {
  link: DrawableLink;
  /** The peer node's floor, when known. `null` only if the API's own node/link data were inconsistent (peer resolved but missing from `nodes`) -- defensive, should not happen given a correct topology response. */
  peerFloor: number | null;
}

export interface FloorLinkBuckets {
  /** Fully resolved, both endpoints on this floor -- the only links ever drawn as a line on this floor's plan. */
  drawable: DrawableLink[];
  /** Resolved links spanning two different floors -- touch this floor at one endpoint only; never drawn as a flat, same-plane line. */
  crossFloor: CrossFloorLinkInfo[];
  /** `geometry === null` -- unresolved peer, or an endpoint without a placed position. Surfaced with a reason, never dropped or given fabricated coordinates. */
  unresolved: UnresolvedLinkInfo[];
}

/**
 * Explains why a link's geometry didn't resolve, purely from data already
 * in hand -- this never re-derives geometry itself (`TopologyLinkGeometry`
 * is computed server-side in routes/topology.ts and trusted verbatim here).
 */
export function explainMissingGeometry(link: HouseMapLink, nodesById: ReadonlyMap<number, HouseMapNode>): string {
  if (link.peerNodeId === null) {
    return `peer MAC ${link.linkMac} has not resolved to a configured node`;
  }
  const fromNode = nodesById.get(link.nodeId);
  const peerNode = nodesById.get(link.peerNodeId);
  const missing: string[] = [];
  if (!fromNode?.position) missing.push(fromNode ? fromNode.name : `node #${link.nodeId}`);
  if (!peerNode?.position) missing.push(peerNode ? peerNode.name : `node #${link.peerNodeId}`);
  if (missing.length > 0) {
    return `${missing.join(' and ')} ${missing.length > 1 ? 'have' : 'has'} no configured position yet`;
  }
  // ponytail: defensive fallback -- routes/topology.ts guarantees geometry
  // is non-null whenever the peer resolves and both endpoints are placed,
  // so this branch should be unreachable given a correct API response. A
  // defensive message beats a blank one if that contract ever drifts.
  return 'geometry unavailable for an unknown reason';
}

/**
 * Buckets every link "owned" by `floor` (its OBSERVING node, `link.nodeId`,
 * lives on `floor`) into drawable / cross-floor / unresolved. A link whose
 * observing node lives on a different floor is skipped here entirely --
 * not duplicated, not dropped overall -- so every link appears in exactly
 * one floor's buckets across the whole app.
 */
export function classifyLinksForFloor(
  links: readonly HouseMapLink[],
  nodesById: ReadonlyMap<number, HouseMapNode>,
  floor: number,
): FloorLinkBuckets {
  const drawable: DrawableLink[] = [];
  const crossFloor: CrossFloorLinkInfo[] = [];
  const unresolved: UnresolvedLinkInfo[] = [];

  for (const link of links) {
    const fromNode = nodesById.get(link.nodeId);
    if (!fromNode || fromNode.floor !== floor) continue;

    if (link.geometry === null) {
      unresolved.push({ link, reason: explainMissingGeometry(link, nodesById) });
      continue;
    }
    if (link.geometry.sameFloor) {
      drawable.push(link as DrawableLink);
    } else {
      const peerNode = link.peerNodeId !== null ? nodesById.get(link.peerNodeId) : undefined;
      crossFloor.push({ link: link as DrawableLink, peerFloor: peerNode ? peerNode.floor : null });
    }
  }
  return { drawable, crossFloor, unresolved };
}

// --- Level editor (offline placement helper) -----------------------------
//
// This whole section only ever computes a LOCAL preview position and the
// text of a YAML snippet -- it must never be wired to a network call. See
// views/houseMap.ts's top-of-file comment for the full reasoning (config.yaml
// is the single source of truth for placement; ingest re-projects it into
// the DB on every start, so a "save" button here would create split-brain
// state silently undone on the next restart).

/** A pending drag/typed override wins over the node's real, server-known position -- but only ever in this browser tab's local state; never persisted anywhere. */
export function effectivePosition(node: HouseMapNode, pending: ReadonlyMap<number, Point>): Point | null {
  return pending.get(node.id) ?? node.position;
}

/**
 * Parses the level editor's raw X/Y text inputs into a placement
 * candidate, or `null` when incomplete/invalid. This is the ONLY gate
 * between "the operator typed something" and a coordinate reaching the
 * shared plan or a YAML snippet, so it must never turn a blank field into
 * a fabricated `0` -- `Number('')` is `0`, not `NaN`, so blank/whitespace
 * has to be rejected explicitly before `Number()`, not left to
 * `Number.isFinite` alone (which would let a cleared field through as a
 * real, drawn `x: 0`/`y: 0`).
 */
export function parsePositionInput(rawX: string, rawY: string): Point | null {
  if (rawX.trim() === '' || rawY.trim() === '') return null;
  const x = Number(rawX);
  const y = Number(rawY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Centimetre precision -- plenty for a hand-placed household floor plan, and keeps the emitted snippet from carrying meaningless float noise from pixel-space drag math. */
const YAML_DECIMALS = 2;

function roundMetres(v: number): number {
  const f = 10 ** YAML_DECIMALS;
  const rounded = Math.round(v * f) / f;
  return rounded === 0 ? 0 : rounded; // normalises -0 -- "-0m" in an emitted YAML snippet would be confusing noise, not a meaningful position.
}

export function roundPlacement(p: Point): Point {
  return { x: roundMetres(p.x), y: roundMetres(p.y) };
}

/**
 * The ONLY output of the level editor: a copy-pasteable YAML fragment
 * matching `nodeSchema`'s real `floor`/`position` shape
 * (packages/config/src/schema.ts) for the operator to merge by hand into
 * that node's own entry in config.yaml. Deliberately NOT a full node object
 * (no `id`/`name`/`room`/`psk`) -- this dashboard never sees a node's PSK
 * (a secret, never returned by GET /api/topology or anything else this view
 * calls) and must not invite the operator to blindly overwrite one from a
 * browser-typed value.
 */
export function buildPlacementYaml(node: Pick<HouseMapNode, 'id' | 'name' | 'room'>, floor: number, position: Point): string {
  const p = roundPlacement(position);
  return [
    `# ${node.name} (id ${node.id}, room "${node.room}") -- merge into its entry under nodes: in config.yaml`,
    `floor: ${floor}`,
    'position:',
    `  x: ${p.x}`,
    `  y: ${p.y}`,
  ].join('\n');
}
