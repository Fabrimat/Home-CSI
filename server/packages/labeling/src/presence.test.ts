import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addDevice,
  deriveWeakOccupancyCount,
  loadPresenceFile,
  probeAllDevices,
  removeDevice,
  savePresenceFile,
  type PresenceDevice,
  type TcpConnector,
} from './presence.js';

function tempFilePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'homecsi-presence-test-'));
  return path.join(dir, 'devices.json');
}

describe('loadPresenceFile / savePresenceFile', () => {
  it('returns an empty device list when the file does not exist yet', () => {
    const file = loadPresenceFile(tempFilePath());
    expect(file.devices).toEqual([]);
  });

  it('round-trips a saved file', () => {
    const filePath = tempFilePath();
    savePresenceFile(filePath, { devices: [{ name: 'alice-phone', host: '192.168.1.50', port: 62078 }] });
    const loaded = loadPresenceFile(filePath);
    expect(loaded.devices).toEqual([{ name: 'alice-phone', host: '192.168.1.50', port: 62078 }]);
  });
});

describe('addDevice / removeDevice', () => {
  it('adds a device', () => {
    const file = addDevice({ devices: [] }, 'alice-phone', '192.168.1.50', 1234);
    expect(file.devices).toEqual([{ name: 'alice-phone', host: '192.168.1.50', port: 1234 }]);
  });

  it('replaces an existing device with the same name rather than duplicating', () => {
    let file = addDevice({ devices: [] }, 'alice-phone', '192.168.1.50', 1234);
    file = addDevice(file, 'alice-phone', '192.168.1.99', 1234);
    expect(file.devices).toHaveLength(1);
    expect(file.devices[0]!.host).toBe('192.168.1.99');
  });

  it('removes a device by name', () => {
    let file = addDevice({ devices: [] }, 'alice-phone', '192.168.1.50', 1234);
    file = removeDevice(file, 'alice-phone');
    expect(file.devices).toEqual([]);
  });
});

/** In-memory fake standing in for a real TCP connect attempt. No network. */
class FakeConnector implements TcpConnector {
  constructor(private readonly reachableHosts: Set<string>) {}
  async isReachable(host: string): Promise<boolean> {
    return this.reachableHosts.has(host);
  }
}

class ThrowingConnector implements TcpConnector {
  async isReachable(): Promise<boolean> {
    throw new Error('simulated network failure');
  }
}

describe('probeAllDevices', () => {
  const devices: PresenceDevice[] = [
    { name: 'alice-phone', host: '192.168.1.50', port: 1 },
    { name: 'bob-phone', host: '192.168.1.51', port: 1 },
  ];

  it('reports reachable/unreachable per device', async () => {
    const results = await probeAllDevices(devices, new FakeConnector(new Set(['192.168.1.50'])));
    expect(results).toEqual([
      { device: devices[0], reachable: true },
      { device: devices[1], reachable: false },
    ]);
  });

  it('CRITICAL: a single device erroring does not crash the whole probe round', async () => {
    const results = await probeAllDevices(devices, new ThrowingConnector());
    expect(results).toEqual([
      { device: devices[0], reachable: false },
      { device: devices[1], reachable: false },
    ]);
  });

  it('handles an empty device list', async () => {
    const results = await probeAllDevices([], new FakeConnector(new Set()));
    expect(results).toEqual([]);
  });
});

describe('deriveWeakOccupancyCount', () => {
  it('maps 0 reachable devices to 0', () => {
    expect(deriveWeakOccupancyCount([])).toBe(0);
  });

  it('maps 1 reachable device to 1', () => {
    expect(
      deriveWeakOccupancyCount([{ device: { name: 'a', host: 'h', port: 1 }, reachable: true }]),
    ).toBe(1);
  });

  it('caps at 2 for 2 or more reachable devices (0/1/2+ scale)', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      device: { name: `d${i}`, host: 'h', port: 1 },
      reachable: true,
    }));
    expect(deriveWeakOccupancyCount(many)).toBe(2);
  });
});
