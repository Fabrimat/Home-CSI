import { apiGet } from './api.js';
import { formatRelative } from './dom.js';

/**
 * Turning MAC addresses back into node names, and ordering link pickers by
 * how recently each link was actually heard.
 *
 * WHY THIS IS NOT TRIVIAL: `csi_records` stores only MACs (`src_mac` /
 * `dst_mac`), because the capturing node reports what it saw on the air and
 * has no idea which of those transmitters are its own siblings. The mapping
 * back to a node is the registry's `expectedMac` (`GET /api/nodes`, from
 * `config.yaml`'s per-node entry) -- so a peer node is nameable exactly when
 * an operator filled that field in, and NOT nameable otherwise. Every
 * function here falls back to the raw MAC rather than inventing a name: an
 * unrecognised transmitter is the normal case in this deployment (the whole
 * point is promiscuous capture of other devices' traffic, see
 * docs/architecture.md), not an error to paper over.
 */

/** Mirrors the `GET /api/nodes` row (server/packages/api/src/db/pgDb.ts `listNodes`). */
export interface NodeInfo {
  id: number;
  name: string;
  room: string;
  expectedMac: string | null;
}

/** The subset of `GET /api/links` this module needs to label and order a link. */
export interface LinkLike {
  nodeId: number;
  srcMac: string;
  dstMac: string;
  lastSeenAt: string;
}

/**
 * Compares MACs by their hex digits only, so `3C:61:05:0F:FF:BC`,
 * `3c-61-05-0f-ff-bc` and `3c61050fffbc` are one address. The registry is
 * hand-edited YAML and the wire format is whatever the node reported, so
 * assuming both sides already agree on separators and case would silently
 * lose the match -- and a lost match here is invisible: it just renders a
 * MAC where a name should be.
 */
export function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, '');
}

const BROADCAST_MAC = 'ffffffffffff';

/** Node names and MAC lookups for one page's worth of views. */
export class NodeDirectory {
  private readonly byId = new Map<number, NodeInfo>();
  private readonly byMac = new Map<string, NodeInfo>();

  constructor(nodes: readonly NodeInfo[]) {
    for (const node of nodes) {
      this.byId.set(node.id, node);
      if (node.expectedMac) {
        const key = normalizeMac(node.expectedMac);
        // Two nodes claiming one MAC is a provisioning mistake, not
        // something to resolve silently by last-write-wins: keep the first
        // and leave the second rendering as a bare MAC, which is at least
        // visibly odd rather than confidently wrong.
        if (!this.byMac.has(key)) this.byMac.set(key, node);
      }
    }
  }

  node(nodeId: number): NodeInfo | undefined {
    return this.byId.get(nodeId);
  }

  /** `lab-vessel` when the node is in the registry, `node 3` when it is not. */
  nodeLabel(nodeId: number): string {
    return this.byId.get(nodeId)?.name ?? `node ${nodeId}`;
  }

  /** The node whose `expectedMac` is this address, if any. */
  nodeForMac(mac: string): NodeInfo | undefined {
    return this.byMac.get(normalizeMac(mac));
  }

  /**
   * A node's name, `broadcast`, or the MAC itself. Never a guess: an
   * unmatched MAC is returned verbatim so it stays copy-pasteable into a
   * query or a capture filter.
   */
  macLabel(mac: string): string {
    const key = normalizeMac(mac);
    if (key === BROADCAST_MAC) return 'broadcast';
    return this.byMac.get(key)?.name ?? mac;
  }

  /**
   * `lab-vessel ⟵ lab-beacon → broadcast`: who captured it, then the link as
   * it appeared on the air. The arrow into the capturing node is what keeps
   * this readable -- `src → dst` alone loses the fact that a third party
   * (the node) is the one reporting the frame.
   */
  linkLabel(link: { nodeId: number; srcMac: string; dstMac: string }): string {
    return `${this.nodeLabel(link.nodeId)} ⟵ ${this.macLabel(link.srcMac)} → ${this.macLabel(link.dstMac)}`;
  }

  /** As `linkLabel`, without the destination -- for views keyed on (node, src) only, like the feature inspector. */
  sourceLabel(link: { nodeId: number; srcMac: string }): string {
    return `${this.nodeLabel(link.nodeId)} ⟵ ${this.macLabel(link.srcMac)}`;
  }
}

/** An empty directory: every label falls back to ids and raw MACs. Used until `/api/nodes` resolves, and if it fails. */
export const EMPTY_NODE_DIRECTORY = new NodeDirectory([]);

/**
 * Loads the registry. Deliberately never throws: node names are a display
 * nicety layered on top of link data that is already correct without them,
 * so a failed fetch degrades to MACs rather than taking a whole view down
 * with an error state.
 */
export async function loadNodeDirectory(): Promise<NodeDirectory> {
  try {
    const res = await apiGet<{ nodes: NodeInfo[] }>('/api/nodes');
    return new NodeDirectory(res.nodes);
  } catch {
    return EMPTY_NODE_DIRECTORY;
  }
}

/**
 * Most recently heard first.
 *
 * `GET /api/links` already orders by `max(time) DESC`, but link pickers are
 * rebuilt from cached arrays on every refresh and the ordering is something
 * the operator is explicitly reading meaning into ("which node is alive
 * right now?"), so it is re-established here rather than inherited from
 * whatever order the array happens to be in. Returns a new array; does not
 * mutate the input.
 */
export function sortByRecency<T extends { lastSeenAt: string }>(links: readonly T[]): T[] {
  return [...links].sort((a, b) => {
    const at = new Date(a.lastSeenAt).getTime();
    const bt = new Date(b.lastSeenAt).getTime();
    // Unparseable timestamps sort last rather than scrambling the order
    // around them (NaN comparisons are all false, which would leave the
    // sort dependent on the engine's algorithm).
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return bt - at;
  });
}

/** `lab-vessel ⟵ lab-beacon → broadcast · 8s ago` -- the picker option text. */
export function linkOptionText(dir: NodeDirectory, link: LinkLike, includeDst = true): string {
  const base = includeDst ? dir.linkLabel(link) : dir.sourceLabel(link);
  return `${base} · ${formatRelative(link.lastSeenAt)}`;
}
