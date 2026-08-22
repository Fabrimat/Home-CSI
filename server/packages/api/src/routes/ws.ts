import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { tokensMatch } from '../auth.js';
import { macAddressSchema, nodeIdSchema } from '../schemas.js';
import { isValidSubscription, type LiveHub, type LiveSubscription } from '../live/hub.js';

const AUTH_TIMEOUT_MS = 5000;

const authMessageSchema = z.object({
  type: z.literal('auth'),
  token: z.string().min(1),
});

const subscriptionShapeSchema = z.object({
  channel: z.enum(['csi', 'occupancy', 'heartbeat']),
  nodeId: nodeIdSchema.optional(),
  srcMac: macAddressSchema.optional(),
  dstMac: macAddressSchema.optional(),
});

const subscribeMessageSchema = z.object({ type: z.literal('subscribe') }).and(subscriptionShapeSchema);
const unsubscribeMessageSchema = z.object({ type: z.literal('unsubscribe') }).and(subscriptionShapeSchema);

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

/**
 * WebSocket subscribe/unsubscribe protocol (see report for full spec):
 *
 * Client -> server, first message MUST be `{"type":"auth","token":"..."}` —
 * browsers cannot set a custom Authorization header on the WS handshake, and
 * we deliberately avoid putting the bearer token in the connection URL
 * (query strings end up in proxy/access logs on a public VPS). The socket is
 * closed (code 4401) if auth doesn't arrive/succeed within AUTH_TIMEOUT_MS.
 *
 * After auth, client -> server:
 *   {"type":"subscribe","channel":"csi","nodeId":1,"srcMac":"..","dstMac":".."}
 *   {"type":"subscribe","channel":"heartbeat","nodeId":1}
 *   {"type":"subscribe","channel":"occupancy"}
 *   {"type":"unsubscribe", ...same shape as its subscribe}
 *
 * Server -> client:
 *   {"type":"connected"}
 *   {"type":"subscribed","channel":..., "key":"csi:1:aa:..:bb:.."}
 *   {"type":"unsubscribed","channel":..., "key":"..."}
 *   {"type":"data","channel":..., "key":"...", "records":[...]}
 *   {"type":"error","message":"..."}
 */
export function registerWsRoutes(app: FastifyInstance, hub: LiveHub, apiToken: string): void {
  app.get('/api/ws', { websocket: true }, (socket) => {
    let authenticated = false;

    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4401, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    socket.on('close', () => {
      clearTimeout(authTimer);
      hub.removeSocket(socket);
    });
    socket.on('error', () => {
      clearTimeout(authTimer);
      hub.removeSocket(socket);
    });

    socket.on('message', (raw: Buffer | string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send(socket, { type: 'error', message: 'invalid JSON' });
        return;
      }

      if (!authenticated) {
        const auth = authMessageSchema.safeParse(parsed);
        if (!auth.success || !tokensMatch(auth.data.token, apiToken)) {
          socket.close(4401, 'unauthorized');
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        send(socket, { type: 'connected' });
        return;
      }

      const subscribe = subscribeMessageSchema.safeParse(parsed);
      if (subscribe.success) {
        const sub: LiveSubscription = subscribe.data;
        if (!isValidSubscription(sub)) {
          send(socket, { type: 'error', message: `subscribe: missing required parameters for channel ${sub.channel}` });
          return;
        }
        hub.subscribe(socket, sub);
        send(socket, { type: 'subscribed', ...sub });
        return;
      }

      const unsubscribe = unsubscribeMessageSchema.safeParse(parsed);
      if (unsubscribe.success) {
        const sub: LiveSubscription = unsubscribe.data;
        hub.unsubscribe(socket, sub);
        send(socket, { type: 'unsubscribed', ...sub });
        return;
      }

      send(socket, { type: 'error', message: 'unrecognized message' });
    });
  });
}
