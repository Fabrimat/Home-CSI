import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guards against a real, previously-shipped defect: Compose v2 interpolates
 * every scalar value in docker-compose.yml, and a `$` not immediately
 * followed by `$` (escape), `{` (start of `${VAR}`), or an identifier
 * character (start of `$VAR`) is a hard parse error - "invalid
 * interpolation format ... you may need to escape any $ with another $".
 * A shell script embedded in a YAML block scalar (see the `label-preserve`
 * service's `command:`) can easily contain `$(...)`  command substitution
 * or `$?` that reads as perfectly normal shell but is exactly this
 * forbidden pattern to Compose - a YAML parser (and every other check in
 * this repo) accepts it happily, which is precisely why this class of bug
 * shipped once already and nothing caught it until an actual `docker
 * compose up` was attempted.
 *
 * No `docker` CLI is available in this repo's CI/dev sandbox to invoke
 * Compose's own interpolation directly, so this test reimplements just
 * enough of Compose's interpolation grammar (see compose-spec's
 * `interpolation` package) to catch the one thing that matters here: an
 * unescaped, non-variable `$`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const composePath = path.join(repoRoot, 'ops', 'docker-compose.yml');
const composeCoolifyPath = path.join(repoRoot, 'ops', 'docker-compose.coolify.yml');

export interface BadInterpolationSpot {
  line: number;
  col: number;
  context: string;
}

/**
 * Every `$` in `text` that Compose v2's interpolation would reject: not
 * followed by `$`, `{`, or an identifier-start character. Line/col are
 * 1-based.
 */
export function findUnescapedDollars(text: string): BadInterpolationSpot[] {
  const spots: BadInterpolationSpot[] = [];
  const lines = text.split('\n');
  lines.forEach((line, lineIdx) => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== '$') continue;
      const next = line[i + 1];
      if (next === '$') {
        // Escaped `$$` - valid, and consumes both characters.
        i++;
        continue;
      }
      if (next === '{') {
        // Braced form. Accept only what Compose actually accepts:
        // `${VAR}`, and the modifier forms `${VAR-x}` / `${VAR:-x}` /
        // `${VAR+x}` / `${VAR:+x}` / `${VAR?x}` / `${VAR:?x}`. A bare `${`
        // check would pass `${}`, `${1}`, `${ VAR}` and unclosed `${VAR`,
        // all of which Compose rejects - that gap is why this branch is
        // spelled out rather than short-circuited.
        const braced = /^\$\{[A-Za-z_][A-Za-z0-9_]*(:?[-+?][^}]*)?\}/.exec(line.slice(i));
        if (braced) {
          i += braced[0].length - 1;
          continue;
        }
        spots.push({ line: lineIdx + 1, col: i + 1, context: line.trim() });
        continue;
      }
      if (next !== undefined && /[A-Za-z_]/.test(next)) {
        // `$VAR` form - valid. Note digits are deliberately excluded from
        // the identifier start: Compose rejects `$1` too.
        continue;
      }
      spots.push({ line: lineIdx + 1, col: i + 1, context: line.trim() });
    }
  });
  return spots;
}

describe('ops/docker-compose.yml has no unescaped $ (Compose v2 interpolation)', () => {
  it('the real file has zero unescaped-$ occurrences', () => {
    const text = readFileSync(composePath, 'utf8');
    const spots = findUnescapedDollars(text);
    expect(
      spots,
      spots
        .map((s) => `${composePath}:${s.line}:${s.col}  ${s.context}`)
        .join('\n'),
    ).toEqual([]);
  });

  it('ops/docker-compose.coolify.yml has zero unescaped-$ occurrences', () => {
    // Same defect class, same `label-preserve` shell-in-YAML shape - see
    // that service's `command:` block. Not scanning this file would be
    // exactly the kind of unchecked-promise gap this test exists to close.
    const text = readFileSync(composeCoolifyPath, 'utf8');
    const spots = findUnescapedDollars(text);
    expect(
      spots,
      spots
        .map((s) => `${composeCoolifyPath}:${s.line}:${s.col}  ${s.context}`)
        .join('\n'),
    ).toEqual([]);
  });

  it('discriminates: flags a $(...) command substitution embedded in a shell script', () => {
    const buggy = 'command:\n  - |\n    echo "ran at $(date -u +%FT%TZ)";\n';
    const spots = findUnescapedDollars(buggy);
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({ line: 3 });
  });

  it('discriminates: flags a bare $?', () => {
    const buggy = 'command:\n  - |\n    echo "exit was $?";\n';
    const spots = findUnescapedDollars(buggy);
    expect(spots).toHaveLength(1);
  });

  it('accepts the escaped forms Compose actually wants', () => {
    const fixed =
      'command:\n  - |\n    echo "ran at $$(date -u +%FT%TZ), exit $$?";\n' +
      'environment:\n  FOO: ${BAR:-default}\n  BAZ: $QUX\n';
    expect(findUnescapedDollars(fixed)).toEqual([]);
  });
});
