import { describe, expect, it } from 'vitest';
import {
  optionalIntFlag,
  optionalNumberFlag,
  optionalStringFlag,
  parseArgs,
  requireStringFlag,
} from './argParsing.js';

describe('parseArgs', () => {
  it('splits leading positionals from --flag value pairs', () => {
    const result = parseArgs(['session', 'start', '--notes', 'hello world']);
    expect(result.positionals).toEqual(['session', 'start']);
    expect(result.flags.notes).toBe('hello world');
  });

  it('treats a --flag immediately followed by another --flag as a boolean switch', () => {
    const result = parseArgs(['add', '--dry-run', '--count', '2']);
    expect(result.flags['dry-run']).toBe(true);
    expect(result.flags.count).toBe('2');
  });

  it('treats a trailing --flag with no value as a boolean switch', () => {
    const result = parseArgs(['list', '--verbose']);
    expect(result.flags.verbose).toBe(true);
  });

  it('returns empty positionals/flags for an empty input', () => {
    const result = parseArgs([]);
    expect(result.positionals).toEqual([]);
    expect(result.flags).toEqual({});
  });
});

describe('flag coercion helpers', () => {
  it('requireStringFlag throws when missing', () => {
    expect(() => requireStringFlag({}, 'count')).toThrow(/missing required/);
  });

  it('requireStringFlag returns the value when present', () => {
    expect(requireStringFlag({ count: '2' }, 'count')).toBe('2');
  });

  it('optionalStringFlag returns undefined when absent, value when present', () => {
    expect(optionalStringFlag({}, 'notes')).toBeUndefined();
    expect(optionalStringFlag({ notes: 'x' }, 'notes')).toBe('x');
  });

  it('optionalIntFlag parses integers and rejects non-numeric input', () => {
    expect(optionalIntFlag({ session: '42' }, 'session')).toBe(42);
    expect(optionalIntFlag({}, 'session')).toBeUndefined();
    expect(() => optionalIntFlag({ session: 'nope' }, 'session')).toThrow(/must be an integer/);
  });

  it('optionalNumberFlag parses floats', () => {
    expect(optionalNumberFlag({ split: '0.8' }, 'split')).toBe(0.8);
    expect(() => optionalNumberFlag({ split: 'nope' }, 'split')).toThrow(/must be a number/);
  });
});
