import { describe, expect, it } from 'vitest';
import { DeviceTokenRegistry, deriveDeviceToken } from './deviceAuth.js';

// Golden vector from the brief, independently re-derived by the firmware's
// own host test (brief B3) -- hardcoded here, not computed with this same
// implementation, so the test actually proves agreement between the two
// independent sides rather than that the code agrees with itself (same
// philosophy as docs-example.test.ts).
const GOLDEN_PSK_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const GOLDEN_DEVICE_TOKEN = 'vnZF_AsH210GnvmaYzfzoal766XSj94IT65l4xwYm18';

describe('deriveDeviceToken', () => {
  it('reproduces the golden vector', () => {
    expect(deriveDeviceToken(GOLDEN_PSK_BASE64)).toBe(GOLDEN_DEVICE_TOKEN);
  });

  it('is deterministic for the same PSK', () => {
    expect(deriveDeviceToken(GOLDEN_PSK_BASE64)).toBe(deriveDeviceToken(GOLDEN_PSK_BASE64));
  });

  it('produces a 43-char base64url string with no padding', () => {
    const token = deriveDeviceToken(GOLDEN_PSK_BASE64);
    expect(token).toHaveLength(43);
    expect(token).not.toContain('=');
    expect(token).not.toContain('+');
    expect(token).not.toContain('/');
  });

  it('produces a different token for a different PSK', () => {
    const otherPsk = 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=';
    expect(deriveDeviceToken(otherPsk)).not.toBe(deriveDeviceToken(GOLDEN_PSK_BASE64));
  });
});

describe('DeviceTokenRegistry', () => {
  it('resolves a valid device token to its node id', () => {
    const registry = new DeviceTokenRegistry([
      { id: 1, psk: GOLDEN_PSK_BASE64 },
      { id: 2, psk: 'Hx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=' },
    ]);
    expect(registry.resolve(GOLDEN_DEVICE_TOKEN)).toBe(1);
  });

  it('returns null for a token that matches no configured node', () => {
    const registry = new DeviceTokenRegistry([{ id: 1, psk: GOLDEN_PSK_BASE64 }]);
    expect(registry.resolve('not-a-real-token')).toBeNull();
  });

  it('returns null for an empty registry', () => {
    const registry = new DeviceTokenRegistry([]);
    expect(registry.resolve(GOLDEN_DEVICE_TOKEN)).toBeNull();
  });

  it('refuses to construct when two nodes share a PSK, naming both node ids', () => {
    expect(
      () =>
        new DeviceTokenRegistry([
          { id: 1, psk: GOLDEN_PSK_BASE64 },
          { id: 7, psk: GOLDEN_PSK_BASE64 },
        ]),
    ).toThrow(/nodes 1 and 7/);
  });
});
