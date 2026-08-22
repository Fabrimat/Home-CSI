import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { attachLiveAndStatic, buildApp } from '../server.js';
import { FakeHomeCsiDb } from '../testUtils/fakeDb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_TOKEN = 'a-long-enough-test-token-1234567890';
const NONEXISTENT_ASSETS_DIR = path.join(__dirname, '..', '__no-such-web-assets-dir__');

async function makeAppWithWs(): Promise<FastifyInstance> {
  const db = new FakeHomeCsiDb();
  const app = buildApp({ db, apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR });
  await attachLiveAndStatic(app, { db, apiToken: API_TOKEN, webAssetsDir: NONEXISTENT_ASSETS_DIR });
  await app.ready();
  return app;
}

function waitForMessage(ws: { once: (event: string, cb: (data: unknown) => void) => void }): Promise<unknown> {
  return new Promise((resolve) => ws.once('message', (data: unknown) => resolve(data)));
}

function waitForClose(ws: { once: (event: string, cb: (code: number, reason: Buffer) => void) => void }): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code: number) => resolve(code)));
}

describe('WebSocket auth', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('closes the socket with 4401 if the first message is not an auth message', async () => {
    app = await makeAppWithWs();
    const ws = await app.injectWS('/api/ws');
    const closed = waitForClose(ws as never);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'occupancy' }));
    const code = await closed;
    expect(code).toBe(4401);
  });

  it('closes the socket with 4401 for a well-formed auth message carrying the wrong token', async () => {
    app = await makeAppWithWs();
    const ws = await app.injectWS('/api/ws');
    const closed = waitForClose(ws as never);
    ws.send(JSON.stringify({ type: 'auth', token: 'definitely-not-the-right-token' }));
    const code = await closed;
    expect(code).toBe(4401);
  });

  it('accepts the connection and confirms once the correct token is sent', async () => {
    app = await makeAppWithWs();
    const ws = await app.injectWS('/api/ws');
    const reply = waitForMessage(ws as never);
    ws.send(JSON.stringify({ type: 'auth', token: API_TOKEN }));
    const raw = await reply;
    const parsed = JSON.parse((raw as Buffer | string).toString()) as { type: string };
    expect(parsed.type).toBe('connected');
  });

  it('rejects a subscribe request missing required parameters for its channel, without closing the socket', async () => {
    app = await makeAppWithWs();
    const ws = await app.injectWS('/api/ws');

    const connected = waitForMessage(ws as never);
    ws.send(JSON.stringify({ type: 'auth', token: API_TOKEN }));
    await connected; // 'connected' ack

    const reply = waitForMessage(ws as never);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'csi' })); // missing nodeId/srcMac/dstMac
    const raw = await reply;
    const parsed = JSON.parse((raw as Buffer | string).toString()) as { type: string; message?: string };
    expect(parsed.type).toBe('error');
  });
});
