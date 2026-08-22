const NOT_IMPLEMENTED_PREFIX = 'not implemented yet';

/**
 * Builds the standard "not implemented yet" error message a stub package's
 * exported command function throws. Owner is the brief id, e.g. "B3".
 * packages/cli/CONTRACTS.md documents this convention for sibling briefs.
 */
export function notImplementedMessage(owner: string): string {
  return `${NOT_IMPLEMENTED_PREFIX} — owned by brief ${owner}`;
}

/**
 * Runs `fn` (which typically dynamically imports a sibling package and
 * calls its contracted export) and turns the stub convention above into a
 * clean one-line message instead of a stack trace. Any *other* error
 * (i.e. a real implementation that actually failed) still prints its full
 * stack, since by then it's a real bug, not an expected gap.
 */
export async function runOwnedCommand(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(NOT_IMPLEMENTED_PREFIX)) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    console.error(err);
    process.exitCode = 1;
  }
}
