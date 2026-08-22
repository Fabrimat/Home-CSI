import { getToken } from './api.js';

export type LiveChannel = 'csi' | 'occupancy' | 'heartbeat';

export interface LiveSubscription {
  channel: LiveChannel;
  nodeId?: number;
  srcMac?: string;
  dstMac?: string;
}

export interface LiveDataMessage {
  type: 'data';
  channel: LiveChannel;
  key: string;
  records: Array<Record<string, unknown>>;
}

type ConnState = 'connecting' | 'open' | 'closed';

/**
 * One shared WebSocket connection for the whole app, reconnecting with
 * backoff and re-issuing subscriptions on reconnect. The URL is derived
 * entirely from `location` (never a hardcoded origin) so this works behind
 * a TLS-terminating reverse proxy.
 */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private state: ConnState = 'closed';
  private subs = new Map<string, LiveSubscription>();
  private dataHandlers = new Set<(msg: LiveDataMessage) => void>();
  private stateHandlers = new Set<(state: ConnState) => void>();
  private reconnectDelayMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  onData(handler: (msg: LiveDataMessage) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onStateChange(handler: (state: ConnState) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => this.stateHandlers.delete(handler);
  }

  subscribe(sub: LiveSubscription): () => void {
    const key = subKey(sub);
    this.subs.set(key, sub);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', ...sub }));
    }
    return () => {
      this.subs.delete(key);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'unsubscribe', ...sub }));
      }
    };
  }

  private setState(state: ConnState): void {
    this.state = state;
    for (const h of this.stateHandlers) h(state);
  }

  private open(): void {
    const token = getToken();
    if (!token) {
      // No point connecting yet; the token gate will call connect() again once set.
      this.setState('closed');
      return;
    }
    this.setState('connecting');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/api/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    });

    ws.addEventListener('message', (event: MessageEvent<string>) => {
      let msg: unknown;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = msg as { type?: string };
      if (parsed.type === 'connected') {
        this.setState('open');
        this.reconnectDelayMs = 1000;
        for (const sub of this.subs.values()) {
          ws.send(JSON.stringify({ type: 'subscribe', ...sub }));
        }
        return;
      }
      if (parsed.type === 'data') {
        for (const h of this.dataHandlers) h(msg as LiveDataMessage);
      }
    });

    ws.addEventListener('close', () => {
      this.setState('closed');
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 1.7, 15000);
  }
}

function subKey(sub: LiveSubscription): string {
  return `${sub.channel}:${sub.nodeId ?? ''}:${sub.srcMac ?? ''}:${sub.dstMac ?? ''}`;
}

export const liveSocket = new LiveSocket();
