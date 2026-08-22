/**
 * Minimal, dependency-free argument parsing for this package's own
 * sub-command tree. `packages/cli` passes every token after `label`/`train`
 * through unparsed (see CONTRACTS.md) — this package owns interpreting
 * them. A hand-rolled parser is used instead of pulling in commander here:
 * the shape is shallow (one or two positional sub-commands plus a handful
 * of `--flag value` pairs) and a library like commander calls
 * `process.exit` on parse errors, which is awkward for a function meant to
 * be called (and tested) as a plain async function.
 */
export interface ParsedArgs {
  /** Leading non-flag tokens, e.g. ["session", "start"] or ["add"]. */
  positionals: string[];
  /** `--flag value` pairs, and bare `--flag` boolean switches. */
  flags: Record<string, string | boolean>;
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

export function requireStringFlag(flags: ParsedArgs['flags'], name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required --${name} <value> argument`);
  }
  return value;
}

export function optionalStringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function optionalIntFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = optionalStringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`--${name} must be an integer, got "${value}"`);
  }
  return parsed;
}

export function optionalNumberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = optionalStringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`--${name} must be a number, got "${value}"`);
  }
  return parsed;
}
