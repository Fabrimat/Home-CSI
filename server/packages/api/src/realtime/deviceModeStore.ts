/**
 * The realtime control plane's shared in-memory state (brief B1): a single
 * global "is realtime on" toggle, optionally scoped to a subset of nodes,
 * that both `GET /device/mode` (routes/device.ts, device-token realm) and
 * `GET|POST /api/realtime` (routes/realtime.ts, dashboard realm) read and
 * write.
 *
 * STATE IS IN-MEMORY ONLY, matching `POST /device/hello`'s
 * `DeviceHelloStore` precedent exactly (routes/device.ts): a process
 * restart falls back to `normal`, the safe default. This is intended, not
 * a gap -- a node enforces its own `expiresAt` against its own local
 * clock regardless of what the server remembers, so the server losing
 * memory of an active realtime window can only make affected nodes revert
 * to `normal` on their next poll (never later than `pollIntervalS`), never
 * cause a node to stay in realtime past its own deadline. That is exactly
 * the safety property that makes this feature safe to ship in the first
 * place (see docs/device-api.md).
 */

export type DeviceMode = 'normal' | 'realtime';

export interface DeviceModeProfile {
  pollIntervalS: number;
  soundingIntervalMs: number;
  soundingRps: number;
  flushBudgetMs: number;
  maxRecordsPerBatch: number;
}

export interface DeviceModeConfig {
  normal: DeviceModeProfile;
  realtime: DeviceModeProfile;
  /** Applied when `POST /api/realtime` omits `durationS`. */
  defaultDurationS: number;
  /** `POST /api/realtime` rejects any `durationS` above this. */
  maxDurationS: number;
}

/**
 * Built-in default when `config.realtime` (or its `device` sub-key) is
 * omitted -- see packages/config/src/schema.ts's `realtimeSchema` comment.
 * The `normal` profile here is also the exact example in docs/device-api.md.
 */
export const DEFAULT_DEVICE_MODE_CONFIG: DeviceModeConfig = {
  normal: { pollIntervalS: 60, soundingIntervalMs: 100, soundingRps: 50, flushBudgetMs: 200, maxRecordsPerBatch: 16 },
  realtime: { pollIntervalS: 10, soundingIntervalMs: 20, soundingRps: 200, flushBudgetMs: 50, maxRecordsPerBatch: 64 },
  defaultDurationS: 600,
  maxDurationS: 3600,
};

/** `GET /device/mode`'s exact response shape. */
export interface DeviceModeResponse extends DeviceModeProfile {
  mode: DeviceMode;
  revision: number;
  /** ISO timestamp, or `null` in `normal` mode -- realtime ALWAYS carries a hard expiry, normal never does. */
  expiresAt: string | null;
}

export interface NodePollInfo {
  nodeId: number;
  lastPolledAt: string;
  appliedRevision: number;
}

/** The dashboard-facing mode's own tri-state: `'unknown'` is not `'normal'` -- see `getPublicStatus`'s doc comment. */
export type PublicMode = DeviceMode | 'unknown';

export interface PublicRealtimeStatus {
  mode: PublicMode;
  revision: number;
  expiresAt: string | null;
  knownSinceRestart: boolean;
  nodes: NodePollInfo[];
}

export type SetRealtimeResult =
  | { status: 'ok'; mode: DeviceModeResponse }
  | { status: 'duration-too-long'; maxDurationS: number };

export class DeviceModeStore {
  private mode: DeviceMode = 'normal';
  private revision = 0;
  private expiresAtMs: number | null = null;
  private targetNodeIds: Set<number> | 'all' = 'all';
  private readonly perNode = new Map<number, NodePollInfo>();

  constructor(
    private readonly config: DeviceModeConfig = DEFAULT_DEVICE_MODE_CONFIG,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reverts to `normal` once a previously-set realtime window's `expiresAt` has passed. Called before every read/write. */
  private reconcileExpiry(): void {
    if (this.mode === 'realtime' && this.expiresAtMs !== null && this.now() >= this.expiresAtMs) {
      this.mode = 'normal';
      this.expiresAtMs = null;
      this.targetNodeIds = 'all';
      this.revision += 1;
    }
  }

  /** Whether the global toggle currently applies to `nodeId` -- always `'normal'` when the toggle itself is off, or when `nodeIds` scoping excluded this node. */
  private effectiveModeFor(nodeId: number): DeviceMode {
    if (this.mode !== 'realtime') return 'normal';
    if (this.targetNodeIds === 'all' || this.targetNodeIds.has(nodeId)) return 'realtime';
    return 'normal';
  }

  private responseFor(effectiveMode: DeviceMode): DeviceModeResponse {
    const profile = effectiveMode === 'realtime' ? this.config.realtime : this.config.normal;
    return {
      mode: effectiveMode,
      revision: this.revision,
      expiresAt:
        effectiveMode === 'realtime' && this.expiresAtMs !== null ? new Date(this.expiresAtMs).toISOString() : null,
      ...profile,
    };
  }

  /**
   * `GET /device/mode` -- resolves what THIS node should be doing right
   * now (honouring `nodeIds` scoping), and records the poll (last-seen
   * time + revision applied) so an operator can see who picked it up
   * (`GET /api/realtime`'s `nodes` array).
   */
  poll(nodeId: number): DeviceModeResponse {
    this.reconcileExpiry();
    const response = this.responseFor(this.effectiveModeFor(nodeId));
    this.perNode.set(nodeId, {
      nodeId,
      lastPolledAt: new Date(this.now()).toISOString(),
      appliedRevision: response.revision,
    });
    return response;
  }

  /**
   * `GET /api/realtime` -- the operator-facing view of the toggle itself.
   * `mode` is deliberately `'unknown'`, never a bare `'normal'`, whenever
   * this store instance has never been toggled since ITS OWN construction
   * (i.e. since the last process restart): nodes may still be bursting on
   * a realtime window this fresh, empty store has no memory of, and
   * claiming `'normal'` would be an outright false statement of fact, not
   * merely stale. `knownSinceRestart` makes that distinction explicit and
   * machine-readable rather than leaving a caller to infer it from
   * `revision === 0`.
   */
  getPublicStatus(): PublicRealtimeStatus {
    this.reconcileExpiry();
    const known = this.revision > 0;
    return {
      mode: known ? this.mode : 'unknown',
      revision: this.revision,
      expiresAt: this.mode === 'realtime' && this.expiresAtMs !== null ? new Date(this.expiresAtMs).toISOString() : null,
      knownSinceRestart: known,
      nodes: [...this.perNode.values()],
    };
  }

  /** `POST /api/realtime`. */
  setRealtime(params: { enabled: boolean; durationS?: number; nodeIds?: number[] | 'all' }): SetRealtimeResult {
    this.reconcileExpiry();
    if (!params.enabled) {
      this.mode = 'normal';
      this.expiresAtMs = null;
      this.targetNodeIds = 'all';
      this.revision += 1;
      return { status: 'ok', mode: this.responseFor('normal') };
    }

    const durationS = params.durationS ?? this.config.defaultDurationS;
    if (durationS > this.config.maxDurationS) {
      return { status: 'duration-too-long', maxDurationS: this.config.maxDurationS };
    }

    this.mode = 'realtime';
    this.expiresAtMs = this.now() + durationS * 1000;
    this.targetNodeIds =
      params.nodeIds === undefined || params.nodeIds === 'all' ? 'all' : new Set(params.nodeIds);
    this.revision += 1;
    return { status: 'ok', mode: this.responseFor('realtime') };
  }
}
