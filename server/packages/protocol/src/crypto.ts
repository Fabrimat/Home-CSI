import { createCipheriv, createDecipheriv } from 'node:crypto';
import { KEY_LEN, NONCE_LEN, TAG_LEN } from './constants.js';
import { ProtocolError } from './header.js';

const ALGORITHM = 'chacha20-poly1305';

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LEN) {
    throw new ProtocolError(`key must be ${KEY_LEN} bytes, got ${key.length}`);
  }
}

function assertNonce(nonce: Buffer): void {
  if (nonce.length !== NONCE_LEN) {
    throw new ProtocolError(`nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
  }
}

/**
 * Seals `plaintext` with ChaCha20-Poly1305, using `header` as AAD (must be
 * the exact 28-byte cleartext header, per docs/protocol.md section 5).
 * Returns the ciphertext concatenated with the 16-byte auth tag, matching
 * the on-wire layout (header || ciphertext || tag).
 */
export function seal(key: Buffer, nonce: Buffer, header: Buffer, plaintext: Buffer): Buffer {
  assertKey(key);
  assertNonce(nonce);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(header, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ciphertext, tag]);
}

/**
 * Opens a sealed `ciphertextAndTag` (as produced by `seal`) using `header`
 * as AAD. Throws ProtocolError on any authentication failure (tampered
 * header, tampered ciphertext, wrong key, wrong nonce).
 */
export function open(
  key: Buffer,
  nonce: Buffer,
  header: Buffer,
  ciphertextAndTag: Buffer,
): Buffer {
  assertKey(key);
  assertNonce(nonce);
  if (ciphertextAndTag.length < TAG_LEN) {
    throw new ProtocolError('ciphertext too short to contain an auth tag');
  }
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - TAG_LEN);
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - TAG_LEN);

  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(header, { plaintextLength: ciphertext.length });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new ProtocolError(
      `AEAD authentication failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
