import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';

/**
 * Automatic *weak* ground-truth labels derived from household phone
 * presence. Manual entry/exit logging (`label session`/`label add`) is
 * accurate but will not survive weeks of real use — nobody remembers to
 * log every trip out for milk. Periodic reachability probing of a short
 * list of known devices gives an approximate, always-on signal instead.
 *
 * This is intentionally simple and self-contained:
 *  - No new config key: `config.features`/`config.occupancy` don't have a
 *    labeling/presence section (nor should this brief invent a parallel
 *    config system for one). Device lists instead live in a small local
 *    JSON file this package owns and manages (see PRESENCE_FILE default
 *    below) — flagged in this brief's report as a config key that would be
 *    reasonable to add later (e.g. `labeling.presenceDevices`).
 *  - No raw ICMP: a TCP reachability probe (successful connect, or even a
 *    fast ECONNREFUSED — meaning *something* answered at that address) is
 *    used instead, since ICMP typically needs elevated privileges and this
 *    is meant to run as an ordinary CLI invocation. This is a coarse
 *    presence heuristic (a phone that's asleep/on a different Wi-Fi/out of
 *    DHCP lease may read as "absent" even if the person is home) — labels
 *    derived from it are stored as explicitly *weak* (see sessions.ts).
 *  - Must never be able to block or crash the main pipelines: this module
 *    is only ever invoked by `label presence probe`, a separate CLI
 *    invocation from `features`/`occupancy`, and every device probe is
 *    individually time-bounded and try/caught so one bad entry can't hang
 *    or fail the whole round.
 */

export interface PresenceDevice {
  name: string;
  host: string;
  port: number;
}

export interface PresenceFile {
  devices: PresenceDevice[];
}

export const DEFAULT_PRESENCE_FILE = 'homecsi-presence-devices.json';
const DEFAULT_PROBE_PORT = 62078; // commonly-open on phones (iOS lockdown / various link-local services); any TCP port works, see module doc.
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

export function loadPresenceFile(filePath: string): PresenceFile {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PresenceFile;
    if (!Array.isArray(parsed.devices)) throw new Error('malformed presence file: "devices" must be an array');
    return parsed;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { devices: [] };
    }
    throw err;
  }
}

export function savePresenceFile(filePath: string, data: PresenceFile): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function addDevice(file: PresenceFile, name: string, host: string, port = DEFAULT_PROBE_PORT): PresenceFile {
  const devices = file.devices.filter((d) => d.name !== name);
  devices.push({ name, host, port });
  return { devices };
}

export function removeDevice(file: PresenceFile, name: string): PresenceFile {
  return { devices: file.devices.filter((d) => d.name !== name) };
}

/** Abstraction over the actual TCP connect attempt, so tests never touch a real network. */
export interface TcpConnector {
  isReachable(host: string, port: number, timeoutMs: number): Promise<boolean>;
}

/** Real TCP connector using Node's net module. */
export function createTcpConnector(): TcpConnector {
  return {
    isReachable(host, port, timeoutMs) {
      return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (reachable: boolean): void => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(reachable);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', (err: NodeJS.ErrnoException) => {
          // ECONNREFUSED means the host answered (just not on this port) —
          // treat as "present". Anything else (timeout, unreachable, DNS
          // failure) reads as absent.
          finish(err.code === 'ECONNREFUSED');
        });
        try {
          socket.connect(port, host);
        } catch {
          finish(false);
        }
      });
    },
  };
}

export interface ProbeResult {
  device: PresenceDevice;
  reachable: boolean;
}

/**
 * Probes every device, independently and time-bounded — a single
 * misbehaving entry (bad hostname, firewalled network) can only ever
 * resolve to `reachable: false` for that device, never throw or hang the
 * whole round.
 */
export async function probeAllDevices(
  devices: readonly PresenceDevice[],
  connector: TcpConnector = createTcpConnector(),
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeResult[]> {
  return Promise.all(
    devices.map(async (device) => {
      try {
        const reachable = await connector.isReachable(device.host, device.port, timeoutMs);
        return { device, reachable };
      } catch {
        return { device, reachable: false };
      }
    }),
  );
}

/**
 * Reduces a probe round to a weak occupancy count on the same 0/1/2+ scale
 * as `occupancy_states.estimate`/`labels.occupancy_count`. Deliberately
 * crude: this counts *reachable devices*, not people (one person can carry
 * two devices, a visitor's phone might be missing from the list entirely,
 * and 2.4GHz-only nodes elsewhere in this system already can't rely on
 * phone Wi-Fi for the primary signal — see docs/architecture.md's "honest
 * capability statement"). It exists purely as a coarse, always-on weak
 * label, not a claim of ground truth.
 */
export function deriveWeakOccupancyCount(results: readonly ProbeResult[]): number {
  const reachableCount = results.filter((r) => r.reachable).length;
  return Math.min(reachableCount, 2);
}
