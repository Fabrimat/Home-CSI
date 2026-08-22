import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time bearer token comparison.
 *
 * We deliberately do NOT short-circuit on `provided.length !== expected.length`
 * (a classic timing side-channel that leaks the correct token's length to an
 * attacker probing a public endpoint) and we do NOT feed the raw strings
 * straight into `timingSafeEqual` either, since that throws on
 * differently-sized buffers -- which itself is a length oracle if the caller
 * has to catch/branch on it. Instead we hash both sides to a fixed-length
 * digest first, so the comparison performed by `timingSafeEqual` always
 * operates on two 32-byte buffers regardless of the original token lengths.
 */
export function tokensMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

const BEARER_PREFIX = 'Bearer ';

/** Extracts the bearer token from an `Authorization` header value, if well-formed. */
export function extractBearerToken(authorizationHeader: string | string[] | undefined): string | null {
  if (typeof authorizationHeader !== 'string') return null;
  if (!authorizationHeader.startsWith(BEARER_PREFIX)) return null;
  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}
