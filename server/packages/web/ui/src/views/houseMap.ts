import './houseMap.css';
import { apiGet, ApiError } from '../api.js';
import { clear, formatRelative, formatTimestamp, h } from '../dom.js';
import { emptyState, errorState, loadingState } from '../components/asyncState.js';
import { viridis } from '../colormap.js';
import {
  buildPlacementYaml,
  classifyLinksForFloor,
  computeFloorExtent,
  computeFloorTransform,
  computeMotionColorScale,
  distinctFloors,
  effectivePosition,
  findZoneFor,
  metresToPixels,
  motionColorT,
  niceScaleBarLengthM,
  parsePositionInput,
  pixelsToMetres,
  topologyChanged,
  type FloorExtent,
  type FloorLinkBuckets,
  type FloorTransform,
  type HouseMapLink,
  type HouseMapLinkMotion,
  type HouseMapNode,
  type HouseMapZone,
  type MotionColorScale,
  type Point,
} from '../houseMapGeometry.js';

/** Mirrors `GET /api/topology`'s response shape (server/packages/api/src/routes/topology.ts), read directly from that file rather than trusted from memory. */
interface TopologyResponse {
  nodes: HouseMapNode[];
  links: HouseMapLink[];
  zones: HouseMapZone[];
  zoneSemantics: string;
}

/*
 * HOUSE MAP -- honesty constraints this whole file must not violate
 * (CLAUDE.md "Amplitude-first", "Motion, not people"; routes/topology.ts's
 * own doc comment):
 *
 *  - ESP32 CSI phase has no hardware TX/RX lock and is not corrected for
 *    CFO/SFO, so nothing here may depend on phase, angle-of-arrival,
 *    time-of-flight, or trilateration. This view draws GLOWING LINKS
 *    (a link is a path between two known, config-placed points; motion on
 *    it localises to that path) and PER-ROOM ZONES (an aggregate over
 *    resolved links touching that room) -- never a person marker, never a
 *    position estimate, never a track, never a heatmap interpolated
 *    between nodes.
 *  - A node with `position: null` is not placed yet and is NEVER drawn --
 *    not at (0,0), not anywhere invented. A link with `geometry: null`
 *    (unresolved peer, or an endpoint without a position) is NEVER dropped
 *    silently and NEVER given fabricated coordinates -- it is listed with
 *    the reason it can't be drawn instead.
 *
 * THE LEVEL EDITOR IS READ-ONLY WITH RESPECT TO THE SERVER, DELIBERATELY:
 * config.yaml is the single source of truth for node placement (it also
 * holds per-node PSKs), and ingest re-projects it into the `nodes` table on
 * every start. A "save this position" button here would create split-brain
 * state that the very next restart would silently undo -- worse than no
 * editor at all, because it would look like it worked. Dragging a node (or
 * typing x/y for an already-placed one) only ever updates LOCAL browser
 * state (`pendingPositions`, below) and the text of a copy-pasteable YAML
 * snippet; there is no placement write endpoint, and this file must never
 * add one or call `apiPost`/`apiPatch` for anything placement-related.
 */

const SVG_WIDTH = 900;
const SVG_HEIGHT = 560;
const SVG_NS = 'http://www.w3.org/2000/svg';
const GLOW_FILTER_ID = 'house-map-link-glow';

// A live-feeling snapshot, not a play-by-play: /api/topology aggregates
// link motion over the whole [from, to) window requested, so too short a
// window would flap the glow on and off between polls for no real reason.
// 5 minutes of aggregation, refreshed every 5 seconds, is "recent enough to
// feel live" without being noisy tick-to-tick.
const MOTION_WINDOW_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

const HONESTY_SENTENCE = 'This shows which paths through the house are disturbed, not where anyone is.';

/** Shown in the level editor's snippet cell whenever `parsePositionInput` rejects the current X/Y pair (blank, whitespace, or not a finite number) -- a visible explanation instead of a silent no-op, without a new aria-live region that would fire on every keystroke. */
const INCOMPLETE_INPUT_TEXT = 'x and y must both be filled in with numbers to generate a snippet';

function svgEl(name: string, attrs: Record<string, string | number> = {}): SVGElement {
  const el = document.createElementNS(SVG_NS, name) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function svgTitle(text: string): SVGTitleElement {
  const title = document.createElementNS(SVG_NS, 'title') as SVGTitleElement;
  title.textContent = text;
  return title;
}

function motionColorCss(t: number): string {
  const [r, g, b] = viridis(t);
  return `rgb(${r}, ${g}, ${b})`;
}

function floorLabel(floor: number): string {
  return `Floor ${floor}`;
}

/** "kitchen-node → hallway-node" (or the raw MAC when the peer never resolved to a node) -- shared by every table/list that names a link. */
function linkLabel(link: HouseMapLink, nodesById: ReadonlyMap<number, HouseMapNode>): string {
  const fromNode = nodesById.get(link.nodeId);
  const peerNode = link.peerNodeId !== null ? nodesById.get(link.peerNodeId) : undefined;
  const fromLabel = fromNode ? fromNode.name : `#${link.nodeId}`;
  const toLabel = peerNode ? peerNode.name : link.linkMac;
  return `${fromLabel} → ${toLabel}`;
}

function motionCell(motion: HouseMapLinkMotion): [HTMLElement, HTMLElement, HTMLElement, HTMLElement] {
  return [
    h('td', {}, `${motion.meanAbsDeviation.toFixed(2)}σ`),
    h('td', {}, motion.motionActive ? 'yes' : 'no'),
    h('td', {}, String(motion.sampleCount)),
    h('td', {}, formatRelative(motion.lastSeenAt)),
  ];
}

export function renderHouseMap(container: HTMLElement): () => void {
  let disposed = false;

  let topology: TopologyResponse | null = null;
  let selectedFloor: number | null = null;
  let lastErrorMessage: string | null = null;
  /** Guards `statusSummary`'s role="status" text -- only actually reassigned (and therefore only actually announced) when the summary's content differs from last time, never on every poll tick. */
  let lastStatusText = '';

  // Local-only placement drafts: nodeId -> a candidate {x, y} from a drag or
  // a typed edit in the level editor. NEVER sent anywhere -- see the
  // top-of-file comment. Only ever populated for a node that already has a
  // real `position` (dragging repositions an existing marker); typing
  // coordinates for a node that has never been placed only ever updates
  // that row's own YAML preview text, and deliberately does NOT enter this
  // map or get drawn on the shared plan -- see buildLevelEditorRow below.
  const pendingPositions = new Map<number, Point>();

  // Rebuilt on every renderBody() call; used only to push live visual
  // updates during a drag/keyboard edit without tearing down and rebuilding
  // the whole SVG (which would drop the in-progress pointer capture).
  let markerRefs = new Map<number, { circle: SVGElement; halo: SVGElement; label: SVGElement }>();
  let editorRefs = new Map<number, { xInput: HTMLInputElement; yInput: HTMLInputElement; snippet: HTMLElement }>();
  let activeSvg: SVGElement | null = null;
  let currentExtent: FloorExtent | null = null;
  let currentTransform: FloorTransform | null = null;
  let draggingNodeId: number | null = null;

  // Two persistent containers inside `body`, created once on the first real
  // render and never recreated after -- only their CONTENTS get cleared and
  // rebuilt from then on. This is what lets a poll-driven render leave the
  // level editor's existing input elements (and thus the operator's
  // in-progress, uncommitted typing + focus) alone while still refreshing
  // everything else: see the `preserveFocusedEditor` guard in renderBody.
  let nonEditorArea: HTMLElement | null = null;
  let editorArea: HTMLElement | null = null;

  const root = h('div', { class: 'view-scroll house-map' });
  container.append(root);

  const floorSelect = h('select', { 'aria-label': 'Floor' }) as HTMLSelectElement;
  // Plain, non-live caption for sighted users -- it ticks every poll
  // (POLL_INTERVAL_MS), so it deliberately does NOT carry role="status":
  // an aria-live region whose text changes every 5 seconds regardless of
  // whether anything meaningful happened would announce a timestamp to a
  // screen reader every 5 seconds, exactly the "interrupt repeatedly"
  // failure this view must avoid.
  const lastPolled = h('span', { class: 'sub' }, '');
  // The one genuinely live-updating, role="status" readout: a summary that
  // only actually changes text (see updateStatusSummary's guard below) when
  // the counts it reports change, so a screen reader is told "a zone just
  // went active", not "still 21:41:05, still 21:41:10, ...". Deliberately
  // NOT on the big tables below (rebuilt wholesale every poll) -- an
  // aria-live region that large would re-announce its entire contents on
  // every tick regardless of this guard.
  const statusSummary = h('span', { class: 'sub', role: 'status' }, '');
  const body = h('div', {});

  root.append(
    h(
      'div',
      { class: 'panel honesty-banner' },
      h('h2', {}, 'House map'),
      h('p', {}, HONESTY_SENTENCE),
      h(
        'p',
        { class: 'sub' },
        'Glowing links and per-room zones show where CSI amplitude motion was detected on a path between two placed nodes -- never a person marker, a position estimate, or a track. Node positions come from config.yaml, placed by the operator by hand (see the level editor at the bottom of each floor).',
      ),
    ),
    h('div', { class: 'controls' }, h('label', {}, 'Floor', floorSelect), lastPolled, statusSummary),
    body,
  );
  body.append(loadingState('Loading house topology…'));

  floorSelect.addEventListener('change', () => {
    const v = Number(floorSelect.value);
    if (Number.isFinite(v)) {
      selectedFloor = v;
      renderBody();
    }
  });

  function syncFloorSelect(floors: number[]): void {
    clear(floorSelect);
    for (const f of floors) floorSelect.append(h('option', { value: String(f) }, floorLabel(f)));
    if (selectedFloor !== null) floorSelect.value = String(selectedFloor);
  }

  async function load(): Promise<void> {
    const to = new Date();
    const from = new Date(to.getTime() - MOTION_WINDOW_MS);
    try {
      const res = await apiGet<TopologyResponse>(
        `/api/topology?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
      );
      if (disposed) return;
      // Computed BEFORE `topology` is overwritten below, against whatever
      // was last actually rendered (or `null` on the very first load,
      // which topologyChanged always treats as changed).
      const changed = topologyChanged(topology, res);
      topology = res;
      lastErrorMessage = null;

      const floors = distinctFloors(res.nodes);
      if (selectedFloor === null || !floors.includes(selectedFloor)) selectedFloor = floors[0] ?? null;
      syncFloorSelect(floors);
      lastPolled.textContent = `last polled ${formatTimestamp(new Date().toISOString())}`;

      if (selectedFloor === null) {
        clear(body);
        nonEditorArea = null; // the persistent containers just got wiped out by clear(body) above -- forget the stale references so the next real renderBody() recreates them instead of appending into detached elements.
        editorArea = null;
        body.append(emptyState('No nodes are configured in config.yaml yet.'));
        return;
      }
      // Two independent guards against tearing the body down from under the
      // operator on every 5s poll tick: an in-progress drag (existing), and
      // `topologyChanged` -- "nothing the plan/tables/legend actually draw
      // from is any different" (see its doc comment in houseMapGeometry.ts).
      // `topologyChanged` alone is NOT enough, though: walking around the
      // house with a tape measure -- the level editor's actual use case --
      // is exactly what makes link motion change on most polls, so
      // `changed` is `true` most of the time in the one house state
      // (occupied) that has motion to measure at all. `renderBody`'s own
      // `preserveFocusedEditor` option is the second half: even when a
      // real render does happen, it leaves the level editor's existing
      // inputs (and the operator's in-progress, uncommitted typing +
      // focus) untouched if focus is currently inside it -- see its
      // comment. This does NOT freeze the view: the plan/zones/link
      // tables still refresh every time `changed` is true, because
      // showing live motion is the whole point of this page.
      if (draggingNodeId === null && changed) renderBody({ preserveFocusedEditor: true });
    } catch (err) {
      if (disposed) return;
      const message = err instanceof ApiError ? err.message : String(err);
      // This view polls every POLL_INTERVAL_MS: an unchanged, ongoing outage
      // must not re-clear()+re-append a fresh role="alert" node (and thus
      // re-announce to a screen reader) on every single tick -- see the
      // identical guard/comment in views/overview.ts.
      if (message === lastErrorMessage) return;
      lastErrorMessage = message;
      clear(body);
      nonEditorArea = null; // see the identical comment above -- clear(body) just detached whatever these pointed to.
      editorArea = null;
      body.append(errorState(message));
    }
  }

  // --- Per-floor render ----------------------------------------------------

  /**
   * `preserveFocusedEditor`: when true (only ever passed by the poll in
   * `load()`) AND focus is currently inside the level editor, its existing
   * DOM (inputs, in-progress values, focus) is left completely alone --
   * `editorRefs` too, so drag/typed updates elsewhere keep targeting the
   * same live elements. Everything else (plan/legend/zones/nodes/links)
   * still rebuilds every time, so live motion keeps updating regardless.
   * Every OTHER caller (floor switch, Reset, drag-drop) omits this and
   * always gets a full rebuild, which is correct: those are the operator's
   * own explicit action -- clicking Reset, for instance, must actually
   * refresh the row it just reset.
   */
  function renderBody(opts: { preserveFocusedEditor?: boolean } = {}): void {
    if (!topology || selectedFloor === null) return;
    const floor = selectedFloor;

    const preserveEditor = opts.preserveFocusedEditor === true && editorArea !== null && editorArea.contains(document.activeElement);

    if (!nonEditorArea || !editorArea) {
      // First real render since the last full teardown (initial load, or
      // after an empty-config/error state) -- (re)create the two
      // persistent slots renderBody reuses (and selectively rebuilds)
      // from now on.
      clear(body);
      nonEditorArea = h('div', {});
      editorArea = h('div', {});
      body.append(nonEditorArea, editorArea);
    }

    markerRefs = new Map();
    activeSvg = null;
    currentExtent = null;
    currentTransform = null;

    const nodesById = new Map<number, HouseMapNode>(topology.nodes.map((n) => [n.id, n]));
    const floorNodes = topology.nodes.filter((n) => n.floor === floor);
    if (floorNodes.length === 0) {
      clear(nonEditorArea);
      clear(editorArea);
      editorRefs = new Map();
      nonEditorArea.append(emptyState(`No nodes are configured on floor ${floor}.`));
      return;
    }
    const placedNodes = floorNodes.filter((n) => effectivePosition(n, pendingPositions) !== null);
    const unplacedNodes = floorNodes.filter((n) => effectivePosition(n, pendingPositions) === null);
    const buckets = classifyLinksForFloor(topology.links, nodesById, floor);
    const floorZones = topology.zones.filter((z) => z.floor === floor);
    const scaleValues = [
      ...buckets.drawable.map((l) => l.motion.meanAbsDeviation),
      ...buckets.crossFloor.map((c) => c.link.motion.meanAbsDeviation),
    ];
    const colorScale = computeMotionColorScale(scaleValues);

    clear(nonEditorArea);
    nonEditorArea.append(
      planPanel(floor, placedNodes, unplacedNodes, buckets, floorZones, colorScale),
      legendPanel(colorScale, scaleValues.length > 0),
      zonesPanel(floorZones, colorScale, topology.zoneSemantics),
      nodesPanel(floorNodes),
      linksPanel(buckets, nodesById),
    );

    if (!preserveEditor) {
      editorRefs = new Map();
      clear(editorArea);
      editorArea.append(levelEditorPanel(floorNodes));
    }
    // else: the operator has focus inside the level editor right now --
    // its DOM and `editorRefs` are left exactly as they were. Whatever
    // changed on this floor while they were in it is picked up by the next
    // render that runs once they're no longer focused there (blur, a floor
    // switch, a drag-drop, or the poll after they tab away).

    updateStatusSummary(floor, placedNodes.length, buckets.drawable.length, floorZones);
  }

  /**
   * Text-content assignment on `statusSummary` (role="status" above) IS the
   * announcement trigger, so this only actually reassigns it when the
   * summary genuinely changed since the last render -- e.g. a zone just
   * flipped `motionActive`, not "still true, still true, ..." every poll.
   * A floor switch always recomputes fresh counts, so it announces too,
   * which is the correct behaviour for a just-taken user action.
   */
  function updateStatusSummary(floor: number, placedCount: number, drawableLinkCount: number, floorZones: HouseMapZone[]): void {
    const activeZoneCount = floorZones.filter((z) => z.motionActive).length;
    const text = `${floorLabel(floor)}: ${placedCount} node(s) placed, ${drawableLinkCount} link(s) drawn, ${activeZoneCount} zone(s) with active motion.`;
    if (text === lastStatusText) return;
    lastStatusText = text;
    statusSummary.textContent = text;
  }

  function planPanel(
    floor: number,
    placedNodes: HouseMapNode[],
    unplacedNodes: HouseMapNode[],
    buckets: FloorLinkBuckets,
    floorZones: HouseMapZone[],
    colorScale: MotionColorScale,
  ): HTMLElement {
    const plan = buildPlan(floor, placedNodes, buckets, floorZones, colorScale);
    const unplacedHint =
      unplacedNodes.length > 0
        ? h(
            'p',
            { class: 'sub' },
            `Not placed yet (no position in config.yaml -- never drawn at a guessed location): ${unplacedNodes
              .map((n) => `${n.name} (${n.room})`)
              .join(', ')}. See the level editor below for a starting config.yaml snippet.`,
          )
        : null;
    return h('div', { class: 'panel' }, h('h2', {}, `Floor plan — ${floorLabel(floor)}`), plan, unplacedHint);
  }

  /** The SVG floor plan itself, or an honest empty state when nothing on this floor has a placed position. */
  function buildPlan(
    floor: number,
    placedNodes: HouseMapNode[],
    buckets: FloorLinkBuckets,
    floorZones: HouseMapZone[],
    colorScale: MotionColorScale,
  ): HTMLElement {
    const positions = placedNodes.map((n) => effectivePosition(n, pendingPositions) as Point);
    const extent = computeFloorExtent(positions);
    if (!extent) {
      return emptyState(
        'No nodes on this floor have a measured position yet. Placement comes from config.yaml, not from anything this system infers -- see the level editor below to draft one.',
      );
    }
    currentExtent = extent;
    const transform = computeFloorTransform(extent, SVG_WIDTH, SVG_HEIGHT);
    currentTransform = transform;

    const svg = svgEl('svg', {
      viewBox: `0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`,
      width: SVG_WIDTH,
      height: SVG_HEIGHT,
      role: 'img',
      'aria-label': `Floor plan for ${floorLabel(floor)}: ${placedNodes.length} placed node(s), ${buckets.drawable.length} link(s) drawn. The tables below this plan are its accessible equivalent.`,
    });
    activeSvg = svg;

    const defs = svgEl('defs');
    const filter = svgEl('filter', { id: GLOW_FILTER_ID, x: '-60%', y: '-60%', width: '220%', height: '220%' });
    filter.append(svgEl('feGaussianBlur', { stdDeviation: 4 }));
    defs.append(filter);
    svg.append(defs);
    svg.append(svgEl('rect', { x: 0, y: 0, width: SVG_WIDTH, height: SVG_HEIGHT, fill: '#0f1420', rx: 8 }));

    // Cross-floor indicators first (background layer): a small marker at
    // the endpoint that IS on this floor, pointing toward the other floor
    // -- never a line drawn to the peer's raw (x, y), which would falsely
    // render two different floors as flat and coplanar.
    for (const cf of buckets.crossFloor) {
      const anchorPx = metresToPixels(cf.link.geometry.from, extent, transform);
      const arrow = cf.peerFloor === null ? '?' : cf.peerFloor > floor ? '↑' : '↓';
      const marker = svgEl('rect', {
        x: anchorPx.x + 9,
        y: anchorPx.y - 21,
        width: 15,
        height: 15,
        fill: '#131722',
        stroke: '#f5c451',
        'stroke-width': 1.5,
        rx: 3,
      });
      marker.append(
        svgTitle(
          `Cross-floor link: ${cf.link.geometry.rooms[0]} (${floorLabel(floor)}) ↔ ${cf.link.geometry.rooms[1]} (${
            cf.peerFloor === null ? 'unknown floor' : floorLabel(cf.peerFloor)
          }) -- shown as an indicator only, never as a flat same-floor line. meanAbsDeviation ${cf.link.motion.meanAbsDeviation.toFixed(2)}σ${cf.link.motion.motionActive ? ', motion ACTIVE' : ''}.`,
        ),
      );
      const glyph = svgEl('text', { x: anchorPx.x + 16.5, y: anchorPx.y - 9.5, fill: '#f5c451', 'font-size': 11, 'text-anchor': 'middle' });
      glyph.textContent = arrow;
      svg.append(marker, glyph);
    }

    // Links: a blurred, motion-coloured glow behind a sharp core line.
    for (const link of buckets.drawable) {
      const geometry = link.geometry;
      const fromPx = metresToPixels(geometry.from, extent, transform);
      const toPx = metresToPixels(geometry.to, extent, transform);
      const t = motionColorT(link.motion.meanAbsDeviation, colorScale);
      const color = motionColorCss(t);
      const glow = svgEl('line', {
        x1: fromPx.x,
        y1: fromPx.y,
        x2: toPx.x,
        y2: toPx.y,
        stroke: color,
        'stroke-width': 4 + t * 10,
        opacity: 0.15 + t * 0.35,
        filter: `url(#${GLOW_FILTER_ID})`,
      });
      const core = svgEl('line', {
        x1: fromPx.x,
        y1: fromPx.y,
        x2: toPx.x,
        y2: toPx.y,
        stroke: color,
        'stroke-width': 1.5 + t * 2,
        opacity: 0.6 + t * 0.4,
      });
      if (link.motion.motionActive) {
        glow.setAttribute('class', 'link-active');
        core.setAttribute('class', 'link-active');
      }
      const label = `${geometry.rooms[0]} ↔ ${geometry.rooms[1]}: meanAbsDeviation ${link.motion.meanAbsDeviation.toFixed(2)}σ${
        link.motion.motionActive ? ', motion ACTIVE' : ''
      }, ${link.motion.sampleCount} samples, last seen ${formatRelative(link.motion.lastSeenAt)}.`;
      glow.append(svgTitle(label));
      core.append(svgTitle(label));
      svg.append(glow, core);
    }

    // Node halos (per-room zone readout) + markers + labels.
    for (const node of placedNodes) {
      const pos = effectivePosition(node, pendingPositions) as Point;
      const px = metresToPixels(pos, extent, transform);
      const zone = findZoneFor(floorZones, node.room, node.floor);
      const haloT = zone ? motionColorT(zone.meanAbsDeviation, colorScale) : null;
      const halo = svgEl('circle', {
        cx: px.x,
        cy: px.y,
        r: 16,
        fill: haloT === null ? '#2a3142' : motionColorCss(haloT),
        opacity: haloT === null ? 0.15 : 0.2 + haloT * 0.4,
      });
      if (zone?.motionActive) halo.setAttribute('class', 'zone-halo-active');
      halo.append(
        svgTitle(
          zone
            ? `${node.room} (${floorLabel(node.floor)}) zone: meanAbsDeviation ${zone.meanAbsDeviation.toFixed(2)}σ across ${zone.linkCount} link(s)${zone.motionActive ? ', ACTIVE' : ''}. Per-room aggregate, not a person count.`
            : `${node.room} (${floorLabel(node.floor)}): no resolved-link zone data yet.`,
        ),
      );

      const circle = svgEl('circle', { cx: px.x, cy: px.y, r: 7, fill: '#5dc8fa', stroke: '#0b0e14', 'stroke-width': 2 });
      circle.setAttribute('style', 'cursor: grab;');
      circle.append(
        svgTitle(
          `${node.name} (#${node.id}) -- ${node.room}, ${floorLabel(node.floor)} -- (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}) m${
            pendingPositions.has(node.id) ? ' [preview -- not saved to config.yaml]' : ''
          }. Drag to preview a new position, or use the level editor below.`,
        ),
      );
      circle.addEventListener('pointerdown', (ev) => startDrag(node.id, ev as PointerEvent));

      const label = svgEl('text', { x: px.x + 10, y: px.y + 4, fill: '#e6e9f0', 'font-size': 11 });
      label.textContent = `${node.name} · ${node.room}`;

      markerRefs.set(node.id, { circle, halo, label });
      svg.append(halo, circle, label);
    }

    // Scale bar -- these are real metres on an arbitrary per-floor origin, so a reference length is the only way a viewer can judge distance at all.
    const barM = niceScaleBarLengthM(extent.widthM);
    const barPx = barM * transform.scale;
    const barX = 16;
    const barY = SVG_HEIGHT - 20;
    const barLabel = svgEl('text', { x: barX, y: barY - 8, fill: '#93a0b8', 'font-size': 11 });
    barLabel.textContent = `${barM} m`;
    svg.append(
      svgEl('line', { x1: barX, y1: barY, x2: barX + barPx, y2: barY, stroke: '#93a0b8', 'stroke-width': 2 }),
      svgEl('line', { x1: barX, y1: barY - 5, x2: barX, y2: barY + 5, stroke: '#93a0b8', 'stroke-width': 2 }),
      svgEl('line', { x1: barX + barPx, y1: barY - 5, x2: barX + barPx, y2: barY + 5, stroke: '#93a0b8', 'stroke-width': 2 }),
      barLabel,
    );

    return h('div', {}, svg);
  }

  // --- Drag-to-preview (mouse/touch) ---------------------------------------
  //
  // Only ever operates on an ALREADY-PLACED node's marker (see the
  // top-of-file comment). The dragged marker moves live for direct visual
  // feedback; connected link lines/halos re-snap into place once the drag
  // ends (renderBody(), a full but cheap rebuild given a house's node
  // count) rather than being kept live in sync stroke-by-stroke -- a
  // deliberate simplification, not a correctness gap: `pendingPositions`
  // itself is updated on every pointermove, so the emitted YAML and the
  // level editor's own live inputs are correct throughout the drag, not
  // just at drop.
  function startDrag(nodeId: number, ev: PointerEvent): void {
    const svg = activeSvg;
    const marker = markerRefs.get(nodeId);
    if (!svg || !marker) return;
    svg.setPointerCapture(ev.pointerId);
    draggingNodeId = nodeId;
    marker.circle.setAttribute('style', 'cursor: grabbing;');

    const onMove = (moveEv: Event): void => updateDragPosition(nodeId, moveEv as PointerEvent, svg);
    const onUp = (upEv: Event): void => {
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerup', onUp);
      svg.releasePointerCapture((upEv as PointerEvent).pointerId);
      draggingNodeId = null;
      renderBody(); // reconcile link lines / halos / editor at the final dropped position
    };
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
  }

  function updateDragPosition(nodeId: number, ev: PointerEvent, svg: SVGElement): void {
    if (!currentExtent || !currentTransform) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const svgX = ((ev.clientX - rect.left) / rect.width) * SVG_WIDTH;
    const svgY = ((ev.clientY - rect.top) / rect.height) * SVG_HEIGHT;
    const metres = pixelsToMetres({ x: svgX, y: svgY }, currentExtent, currentTransform);
    applyPendingPosition(nodeId, metres);
  }

  /** Shared by dragging AND the level editor's number inputs for an already-placed node -- see buildLevelEditorRow. */
  function applyPendingPosition(nodeId: number, point: Point): void {
    pendingPositions.set(nodeId, point);
    const marker = markerRefs.get(nodeId);
    if (marker && currentExtent && currentTransform) {
      const px = metresToPixels(point, currentExtent, currentTransform);
      marker.circle.setAttribute('cx', String(px.x));
      marker.circle.setAttribute('cy', String(px.y));
      marker.halo.setAttribute('cx', String(px.x));
      marker.halo.setAttribute('cy', String(px.y));
      marker.label.setAttribute('x', String(px.x + 10));
      marker.label.setAttribute('y', String(px.y + 4));
    }
    const row = editorRefs.get(nodeId);
    if (row) {
      row.xInput.value = point.x.toFixed(2);
      row.yInput.value = point.y.toFixed(2);
      const node = topology?.nodes.find((n) => n.id === nodeId);
      if (node) row.snippet.textContent = buildPlacementYaml(node, node.floor, point);
    }
  }

  function onResetPlacement(nodeId: number): void {
    pendingPositions.delete(nodeId);
    renderBody();
  }

  // --- Accessible tables (the equivalent representation of the plan above) --

  function nodesPanel(floorNodes: HouseMapNode[]): HTMLElement {
    return h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Nodes on this floor'),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Room'), h('th', {}, 'Position'))),
        h(
          'tbody',
          {},
          ...floorNodes.map((n) => {
            const pos = effectivePosition(n, pendingPositions);
            return h(
              'tr',
              {},
              h('td', {}, `${n.name} (#${n.id})`),
              h('td', {}, n.room),
              h('td', {}, pos ? `${pos.x.toFixed(2)}, ${pos.y.toFixed(2)} m` : 'not placed yet — set in config.yaml (see level editor below)'),
            );
          }),
        ),
      ),
    );
  }

  function linksPanel(buckets: FloorLinkBuckets, nodesById: ReadonlyMap<number, HouseMapNode>): HTMLElement {
    interface Row {
      label: string;
      status: string;
      motion: HouseMapLinkMotion;
    }
    const rows: Row[] = [
      ...buckets.drawable.map((l): Row => ({ label: linkLabel(l, nodesById), status: 'drawn on this plan', motion: l.motion })),
      ...buckets.crossFloor.map(
        (cf): Row => ({
          label: linkLabel(cf.link, nodesById),
          status: `cross-floor indicator only (${cf.link.geometry.rooms[0]} ↔ ${cf.link.geometry.rooms[1]}, ${
            cf.peerFloor === null ? 'peer floor unknown' : floorLabel(cf.peerFloor)
          }) — never drawn as a flat same-floor line`,
          motion: cf.link.motion,
        }),
      ),
      ...buckets.unresolved.map((u): Row => ({ label: linkLabel(u.link, nodesById), status: `not drawn: ${u.reason}`, motion: u.link.motion })),
    ];
    return h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Links observed by nodes on this floor'),
      h(
        'p',
        { class: 'sub' },
        "The accessible equivalent of the glowing lines above: every link this floor's nodes observed in the last 5 minutes, whether or not it could be drawn.",
      ),
      rows.length === 0
        ? emptyState('No links observed by any node on this floor in the last 5 minutes.')
        : h(
            'table',
            {},
            h(
              'thead',
              {},
              h('tr', {}, h('th', {}, 'Link'), h('th', {}, 'Shown as'), h('th', {}, 'meanAbsDeviation'), h('th', {}, 'Active'), h('th', {}, 'Samples'), h('th', {}, 'Last seen')),
            ),
            h('tbody', {}, ...rows.map((r) => h('tr', {}, h('td', {}, r.label), h('td', {}, r.status), ...motionCell(r.motion)))),
          ),
    );
  }

  function zonesPanel(floorZones: HouseMapZone[], colorScale: MotionColorScale, zoneSemantics: string): HTMLElement {
    return h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Zones (per-room motion)'),
      h('p', { class: 'sub' }, zoneSemantics),
      floorZones.length === 0
        ? emptyState('No zone data for this floor yet — every link touching a room here is unresolved (see the links table above), or nothing was observed in the last window.')
        : h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Room'), h('th', {}, 'meanAbsDeviation'), h('th', {}, 'Active'), h('th', {}, 'Links contributing'))),
            h(
              'tbody',
              {},
              ...floorZones.map((z) =>
                h(
                  'tr',
                  {},
                  h(
                    'td',
                    {},
                    h('span', { class: 'zone-swatch', style: `background:${motionColorCss(motionColorT(z.meanAbsDeviation, colorScale))}` }),
                    ` ${z.room}`,
                  ),
                  h('td', {}, `${z.meanAbsDeviation.toFixed(2)}σ`),
                  h('td', {}, z.motionActive ? 'yes' : 'no'),
                  h('td', {}, String(z.linkCount)),
                ),
              ),
            ),
          ),
    );
  }

  function legendPanel(colorScale: MotionColorScale, hasData: boolean): HTMLElement {
    if (!hasData) {
      return h(
        'div',
        { class: 'panel' },
        h('h2', {}, 'Motion colour scale'),
        emptyState('No resolved-link motion data for this floor in the last window — nothing to scale a colour legend against yet.'),
      );
    }
    const gradientId = 'house-map-legend-gradient';
    const legendSvg = svgEl('svg', {
      width: 220,
      height: 20,
      role: 'img',
      'aria-label': `Colour legend: 0 to ${colorScale.max.toFixed(2)} baseline-relative standard deviations`,
    });
    const defs = svgEl('defs');
    const gradient = svgEl('linearGradient', { id: gradientId, x1: '0%', y1: '0%', x2: '100%', y2: '0%' });
    for (const stop of [0, 0.25, 0.5, 0.75, 1]) gradient.append(svgEl('stop', { offset: `${stop * 100}%`, 'stop-color': motionColorCss(stop) }));
    defs.append(gradient);
    legendSvg.append(defs, svgEl('rect', { x: 0, y: 0, width: 220, height: 16, fill: `url(#${gradientId})`, rx: 3 }));
    return h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Motion colour scale'),
      h(
        'div',
        { class: 'legend-row' },
        h('span', {}, '0σ'),
        legendSvg,
        h('span', {}, `${colorScale.max.toFixed(2)}σ (95th percentile of links shown on this floor; brighter/above this saturates)`),
      ),
      h(
        'p',
        { class: 'sub' },
        'meanAbsDeviation: mean of |baseline deviation| across CSI windows for a link, in baseline-relative standard-deviation units — comparable across links, but NOT an amplitude, distance, or person count.',
      ),
    );
  }

  // --- Level editor (offline placement helper) ------------------------------

  function levelEditorPanel(floorNodes: HouseMapNode[]): HTMLElement {
    return h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Level editor (offline placement helper)'),
      h(
        'p',
        { class: 'sub' },
        "Drag a placed node above, or type x/y here (applied on commit — blur or Enter, not per keystroke), to get a config.yaml snippet. For an already-placed node this is a fully keyboard-operable equivalent of dragging (it previews on the plan too); for a not-yet-placed one it only builds the snippet below. This never saves or sends anything to the server — merge the snippet into that node's own entry in config.yaml by hand, then restart ingest to pick it up.",
      ),
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Room'), h('th', {}, 'X (m)'), h('th', {}, 'Y (m)'), h('th', {}, 'Actions'), h('th', {}, 'config.yaml snippet'))),
        h('tbody', {}, ...floorNodes.map((n) => buildLevelEditorRow(n))),
      ),
    );
  }

  function buildLevelEditorRow(node: HouseMapNode): HTMLElement {
    const isPlaced = node.position !== null;
    const current = effectivePosition(node, pendingPositions);
    const xInput = h('input', {
      type: 'number',
      step: '0.01',
      value: current ? String(current.x) : '',
      'aria-label': `X position in metres for ${node.name}`,
    }) as HTMLInputElement;
    const yInput = h('input', {
      type: 'number',
      step: '0.01',
      value: current ? String(current.y) : '',
      'aria-label': `Y position in metres for ${node.name}`,
    }) as HTMLInputElement;
    const snippet = h('pre', { class: 'placement-snippet' }, current ? buildPlacementYaml(node, node.floor, current) : INCOMPLETE_INPUT_TEXT);
    editorRefs.set(node.id, { xInput, yInput, snippet });

    // NOT wired through `applyPendingPosition`/`pendingPositions` for a
    // never-placed node: doing so would put an operator-typed draft
    // position on the shared plan for a node this system has never been
    // told a real position for, which is exactly the "fabricated
    // coordinate" this whole file exists to avoid. A typed draft for such
    // a node only ever feeds this row's own snippet text.
    //
    // Parsing goes through `parsePositionInput`, not a bare `Number(...)`
    // + `Number.isFinite` check here: `Number('')` is `0`, not `NaN`, so a
    // field an operator just cleared (select-all + Delete, then Tab/blur
    // fires `change`) would otherwise silently become a real, drawn `0` --
    // exactly the fabricated coordinate this file exists to avoid, just
    // reached through the keyboard path instead of a mouse drag. An
    // incomplete/invalid pair leaves any already-applied position alone
    // and says so in the snippet cell instead of a silent no-op.
    function recompute(): void {
      const point = parsePositionInput(xInput.value, yInput.value);
      if (!point) {
        snippet.textContent = INCOMPLETE_INPUT_TEXT;
        return;
      }
      if (isPlaced) applyPendingPosition(node.id, point);
      else snippet.textContent = buildPlacementYaml(node, node.floor, point);
    }
    xInput.addEventListener('change', recompute);
    yInput.addEventListener('change', recompute);

    const resetBtn = h(
      'button',
      {
        onclick: () => {
          if (isPlaced) {
            onResetPlacement(node.id);
          } else {
            xInput.value = '';
            yInput.value = '';
            snippet.textContent = INCOMPLETE_INPUT_TEXT;
          }
        },
      },
      'Reset',
    );

    return h('tr', {}, h('td', {}, `${node.name} (#${node.id})`), h('td', {}, node.room), h('td', {}, xInput), h('td', {}, yInput), h('td', {}, resetBtn), h('td', {}, snippet));
  }

  void load();
  const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
