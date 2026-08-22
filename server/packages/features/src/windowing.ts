/**
 * Groups a time-ordered stream of per-record samples into fixed-length,
 * hop-spaced windows, per link, aligned to an absolute wall-clock grid
 * (rather than "first sample seen") so that:
 *
 *  - windows computed by two separate pipeline runs (before/after a resume)
 *    land on identical boundaries, which is what makes the "skip windows
 *    already persisted for this link" resumability check in pipeline.ts
 *    correct; and
 *  - windows for different links are directly comparable/joinable by time
 *    for the occupancy pipeline's cross-link simultaneity logic.
 *
 * A window is only emitted once it is "closed" — i.e. once a sample at or
 * after its end time has been observed for that link — so a window is never
 * emitted based on incomplete, still-arriving data. This means the most
 * recent (windowMs) of a link's data is always held back to the next run.
 */
export interface TimedSample<T> {
  timeMs: number;
  value: T;
}

export interface WindowSpec {
  windowMs: number;
  hopMs: number;
}

export interface Window<T> {
  /** Start of the window, inclusive, aligned to the hop grid (multiple of hopMs). */
  startMs: number;
  /** End of the window, exclusive. */
  endMs: number;
  samples: T[];
}

/** Aligns a timestamp down to the nearest multiple of `hopMs`. */
export function alignToHopGrid(timeMs: number, hopMs: number): number {
  return Math.floor(timeMs / hopMs) * hopMs;
}

/**
 * Builds every closed window over `samples` (must already be sorted
 * ascending by `timeMs`) whose end lies at or before `closedUpToMs` — i.e.
 * a time we're confident no more (earlier) data will arrive for, so the
 * window's contents are final. Callers should pass the *global* latest
 * observed timestamp across all links here, not this link's own last
 * sample time: an idle link's own last sample can be arbitrarily old, and
 * using only that link's data to decide "closed" would leave its windows
 * open (and unemitted) forever once it goes quiet, even though the rest of
 * the mesh has moved on. A window whose end is <= `sinceExclusiveEndMs` is
 * skipped as already emitted on a previous run (resumability).
 */
export function buildWindows<T>(
  samples: readonly TimedSample<T>[],
  spec: WindowSpec,
  closedUpToMs: number,
  sinceExclusiveEndMs: number | null,
): Window<T>[] {
  if (samples.length === 0) return [];

  const minTime = samples[0]!.timeMs;
  const firstGridStart = alignToHopGrid(minTime, spec.hopMs);
  const windows: Window<T>[] = [];

  for (let startMs = firstGridStart; startMs + spec.windowMs <= closedUpToMs; startMs += spec.hopMs) {
    const endMs = startMs + spec.windowMs;
    if (sinceExclusiveEndMs !== null && endMs <= sinceExclusiveEndMs) continue;

    const windowSamples = samples.filter((s) => s.timeMs >= startMs && s.timeMs < endMs);
    if (windowSamples.length === 0) continue;

    windows.push({ startMs, endMs, samples: windowSamples.map((s) => s.value) });
  }

  return windows;
}
