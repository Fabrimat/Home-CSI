import { ProtocolError } from './header.js';

const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

/** Formats a 6-byte MAC address buffer as lowercase colon-separated hex. */
export function macToString(mac: Buffer): string {
  if (mac.length !== 6) {
    throw new ProtocolError(`MAC must be 6 bytes, got ${mac.length}`);
  }
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join(':');
}

/** Parses a lowercase-or-uppercase colon-separated MAC string into 6 bytes. */
export function macToBuffer(mac: string): Buffer {
  if (!MAC_RE.test(mac)) {
    throw new ProtocolError(`invalid MAC address string: ${mac}`);
  }
  return Buffer.from(mac.split(':').map((h) => parseInt(h, 16)));
}
