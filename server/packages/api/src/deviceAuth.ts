import { createHmac } from 'node:crypto';
import { tokensMatch } from './auth.js';

/**
 * Module augmentation for the `/device/*` auth realm's resolved node id
 * (see server.ts's second `onRequest` hook). `null` until that hook runs
 * and successfully resolves a device bearer token; routes registered
 * under `/device/*` (routes/device.ts) can rely on it being non-null by
 * the time they run, since the hook already rejects with 401 otherwise.
 */
declare module 'fastify' {
  interface FastifyRequest {
    deviceNodeId: number | null;
  }
}

/**
 * Fixed ASCII label for the device-token HMAC (docs/device-api.md). Never
 * changes across deployments -- it exists only to domain-separate this
 * derivation from any other use of the same PSK, not to add secrecy.
 */
const DEVICE_TOKEN_LABEL = 'homecsi-device-v1';

/**
 * Derives a node's device-auth bearer token from its configured PSK
 * (docs/device-api.md "Device credential"):
 *
 *   device_token = base64url_nopad(HMAC-SHA256(key = raw 32 PSK bytes,
 *                                               msg = "homecsi-device-v1"))
 *
 * The HMAC is computed over the PSK's raw 32 *decoded* bytes, never over
 * its base64 string -- `pskBase64` is exactly the same string stored in
 * `config.nodes[].psk` (packages/config/src/schema.ts). `Buffer#toString`
 * /`Hmac#digest`'s `'base64url'` encoding already omits padding, matching
 * the wire contract's 43-char, `=`-free output.
 */
export function deriveDeviceToken(pskBase64: string): string {
  const pskRaw = Buffer.from(pskBase64, 'base64');
  return createHmac('sha256', pskRaw).update(DEVICE_TOKEN_LABEL, 'ascii').digest('base64url');
}

/**
 * Resolves a presented `/device/*` bearer token to the node id that derived
 * it. Built once at startup from `config.nodes` -- iterating every
 * configured node (4-9 in practice) and short-circuiting on the first
 * match is fine; the only thing the resulting timing reveals is which node
 * successfully authenticated, which the caller already knows once it gets
 * a 200.
 *
 * Refuses to construct if two configured nodes derive the same token, which
 * can only happen if they share a PSK -- `provision.py` prevents this at
 * flash time, but a hand-edited config.yaml does not, and a shared PSK is
 * catastrophic under this protocol's nonce construction (docs/protocol.md
 * section 4). Better to fail loudly at startup than to silently conflate
 * two nodes' identities.
 */
export class DeviceTokenRegistry {
  private readonly entries: ReadonlyArray<{ nodeId: number; token: string }>;

  constructor(nodes: ReadonlyArray<{ id: number; psk: string }>) {
    const entries = nodes.map((node) => ({ nodeId: node.id, token: deriveDeviceToken(node.psk) }));
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        if (a.token === b.token) {
          throw new Error(
            `duplicate device token derived for nodes ${a.nodeId} and ${b.nodeId} -- ` +
              'they must share the same PSK, which is catastrophic under this ' +
              "protocol's nonce construction (docs/protocol.md section 4). Give " +
              'every node in config.yaml a distinct psk.',
          );
        }
      }
    }
    this.entries = entries;
  }

  /** The node id whose derived token matches `providedToken`, or `null` if none does. */
  resolve(providedToken: string): number | null {
    for (const entry of this.entries) {
      if (tokensMatch(providedToken, entry.token)) return entry.nodeId;
    }
    return null;
  }
}
