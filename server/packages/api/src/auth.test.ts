import { describe, expect, it } from 'vitest';
import { extractBearerToken, tokensMatch } from './auth.js';

describe('tokensMatch', () => {
  const expected = 'a-long-random-token-value-1234567890';

  it('matches identical tokens', () => {
    expect(tokensMatch(expected, expected)).toBe(true);
  });

  it('rejects a token that differs only in one character', () => {
    expect(tokensMatch('a-long-random-token-value-1234567891', expected)).toBe(false);
  });

  it('rejects a shorter token without throwing', () => {
    expect(() => tokensMatch('short', expected)).not.toThrow();
    expect(tokensMatch('short', expected)).toBe(false);
  });

  it('rejects a longer token without throwing', () => {
    expect(tokensMatch(expected + 'extra', expected)).toBe(false);
  });

  it('rejects an empty token', () => {
    expect(tokensMatch('', expected)).toBe(false);
  });
});

describe('extractBearerToken', () => {
  it('extracts the token from a well-formed header', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
  });

  it('returns null for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  it('returns null for a header without the Bearer prefix', () => {
    expect(extractBearerToken('abc123')).toBeNull();
  });

  it('returns null for a Bearer header with no token', () => {
    expect(extractBearerToken('Bearer ')).toBeNull();
  });

  it('returns null when the header is an array (should not happen, but must not throw)', () => {
    expect(extractBearerToken(['Bearer abc123'])).toBeNull();
  });
});
