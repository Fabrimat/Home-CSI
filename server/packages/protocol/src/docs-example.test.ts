import { readFileSync } from 'node:fs';
import { createCipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_BATCH,
  EXAMPLE_BOOT_EPOCH,
  EXAMPLE_KEY,
  EXAMPLE_NODE_ID,
  EXAMPLE_SEQ,
  buildExampleDatagram,
} from './example.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_PATH = path.resolve(__dirname, '../../../../docs/protocol.md');

const BEGIN_MARKER = '<!-- BEGIN GENERATED EXAMPLE -->';
const END_MARKER = '<!-- END GENERATED EXAMPLE -->';

/**
 * ============================ READ THIS ==============================
 * This is a hardcoded golden vector, NOT the output of this package's own
 * encoder. It is derived by hand-laying-out the raw header, nonce, and
 * plaintext bytes directly from docs/protocol.md's own field tables (see
 * the derivation reproduced in the comment below) and sealing them with a
 * *direct* `node:crypto` `chacha20-poly1305` call — it does not call
 * `encodeHeader`, `buildNonce`, `encodeCsiBatch`, `seal`, or
 * `encodeCsiBatchDatagram` from this package at all. That matters: a bug
 * shared between "the encoder" and "the thing checking the encoder" would
 * previously have gone undetected, because an earlier version of this test
 * compared the doc's dump to this package's own encoder output — a
 * tautology that would reproduce a wrong field order, wrong endianness, or
 * a wrong AAD/nonce construction identically on both sides and still pass.
 *
 * This vector is also cross-checked byte-for-byte, by hand, against
 * firmware's independent derivation (a different language, a different
 * AEAD call site) in `firmware/tests/test_docs_example.c`
 * (`g_expected_datagram` / `g_expected_plaintext`). If this ever needs to
 * change, re-derive it independently again and re-confirm agreement with
 * firmware — do not just copy whatever the encoder currently produces.
 * =======================================================================
 *
 * Derivation (see scripts run once, by hand, to produce the hex below):
 *   header  = magic("HCS1") || version(1) || msg_type(1=CSI_BATCH)
 *             || node_id(7, u16 LE) || boot_epoch(3, u32 LE) || seq(42, u32 LE)
 *             || nonce = node_id(u16 LE) || boot_epoch(u32 LE) || seq(u32 LE) || 00 00
 *   plaintext = batch header (wall_clock_us, mono_us, sntp_synced=1, reserved, record_count=1)
 *             || one CSI record (src/dst mac, rssi=-42, rate=11, sig_mode=1, mcs=7,
 *                bandwidth=0, channel=6, secondary_channel=0, noise_floor=-95,
 *                rx_timestamp_us=123456700, csi_format=0/LLTF, csi_len=4, csi_data=01 02 03 04)
 *   datagram = header || chacha20poly1305_seal(key=EXAMPLE_KEY, nonce, aad=header, plaintext)
 */
const GOLDEN_PLAINTEXT_HEX =
  '00401e18240a060015cd5b0700000000010000000100aabbccddee01aabbccddeeffd60b0107000600' +
  'a1bccc5b070000000000040001020304';

const GOLDEN_DATAGRAM_HEX =
  '4843533101010700030000002a0000000700030000002a000000000038a69afdb4bd553b48034403' +
  '22358acc96d95db1beaf3c17553b4467cd72be2e5cd9fae3d43a0180649655db8d83eb4c9cdd04cfc4' +
  'e58ced10fdd6aaa628a5601e5f504f850558fc49';

const GOLDEN_PLAINTEXT = Buffer.from(GOLDEN_PLAINTEXT_HEX, 'hex');
const GOLDEN_DATAGRAM = Buffer.from(GOLDEN_DATAGRAM_HEX, 'hex');

/** Extracts the raw bytes from the doc's "Full datagram" hex dump lines
 * only (format: 4 hex digits, two spaces, hex byte pairs, at column 0) —
 * deliberately does NOT match the indented "Ciphertext" sub-dump further
 * down, which uses the same offset-column style but is indented by two
 * spaces. */
function extractFullDatagramBytes(section: string): Buffer {
  const bytes: number[] = [];
  // Match line-by-line (not with a multiline regex spanning `\n`, which
  // would let `\s*` swallow newlines and merge the next line's 4-digit
  // offset column into the byte stream as spurious extra bytes).
  const lineRe = /^[0-9a-fA-F]{4} {2}((?:[0-9a-fA-F]{2} ?)+)$/;
  for (const line of section.split('\n')) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const tokens = (match[1] ?? '').trim().split(/ +/).filter(Boolean);
    for (const token of tokens) bytes.push(parseInt(token, 16));
  }
  return Buffer.from(bytes);
}

describe('golden vector sanity (independent of this package)', () => {
  it('is internally consistent: re-sealing the same bytes with raw node:crypto reproduces it', () => {
    // This does not call this package's code either — it's a sanity check
    // that the literal above is at least a well-formed ChaCha20-Poly1305
    // sealing of the literal plaintext above, so a future hand-edit of one
    // without the other is caught here rather than only downstream.
    const header = GOLDEN_DATAGRAM.subarray(0, 28);
    const nonce = header.subarray(16, 28);
    const cipher = createCipheriv('chacha20-poly1305', EXAMPLE_KEY, nonce, {
      authTagLength: 16,
    });
    cipher.setAAD(header, { plaintextLength: GOLDEN_PLAINTEXT.length });
    const ciphertext = Buffer.concat([cipher.update(GOLDEN_PLAINTEXT), cipher.final()]);
    const tag = cipher.getAuthTag();
    const resealed = Buffer.concat([header, ciphertext, tag]);
    expect(resealed).toEqual(GOLDEN_DATAGRAM);
  });
});

describe('packages/protocol encoder vs. the independent golden vector', () => {
  it('encodeCsiBatchDatagram output for the S13 example inputs equals the golden vector', () => {
    expect(EXAMPLE_NODE_ID).toBe(7);
    expect(EXAMPLE_BOOT_EPOCH).toBe(3);
    expect(EXAMPLE_SEQ).toBe(42);
    expect(EXAMPLE_BATCH.records).toHaveLength(1);

    const datagram = buildExampleDatagram();
    expect(datagram).toEqual(GOLDEN_DATAGRAM);
  });
});

describe('docs/protocol.md worked example vs. the independent golden vector', () => {
  it('embeds the GENERATED EXAMPLE markers with real content (not the placeholder)', () => {
    const doc = readFileSync(DOCS_PATH, 'utf8');
    expect(doc).toContain(BEGIN_MARKER);
    expect(doc).toContain(END_MARKER);
    expect(doc).not.toContain('GENERATED_EXAMPLE_PLACEHOLDER');
  });

  it("the doc's raw 'Full datagram' hex dump equals the golden vector, byte for byte", () => {
    const doc = readFileSync(DOCS_PATH, 'utf8');
    const begin = doc.indexOf(BEGIN_MARKER);
    const end = doc.indexOf(END_MARKER);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);

    const section = doc.slice(begin + BEGIN_MARKER.length, end);
    const docBytes = extractFullDatagramBytes(section);

    // A failure here means the doc and the golden vector disagree on the
    // actual wire bytes — that's a real spec/doc bug, not a formatting nit.
    expect(docBytes.length).toBe(GOLDEN_DATAGRAM.length);
    expect(docBytes).toEqual(GOLDEN_DATAGRAM);
  });
});
