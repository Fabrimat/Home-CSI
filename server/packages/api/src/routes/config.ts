import type { FastifyInstance } from 'fastify';

/**
 * Client-relevant slice of server config exposed to the dashboard, so it
 * can shade timeline selections that are already past (or approaching) the
 * point of no return for training-set preservation -- the same retention
 * edge `@homecsi/labeling`'s CLI already warns about at `label add`/`label
 * preserve` time (retentionWarning.ts). The dashboard has no other way to
 * learn this deployment's configured debug window: only the API process
 * has actually loaded `config.storage.retention`.
 *
 * Deliberately narrow (two numbers), not the whole `Config` object --
 * nothing else in `Config` is safe or useful to hand to an unauthenticated-
 * at-the-network-layer-but-token-authed browser client, and a narrow,
 * explicit shape means this route's contract can't silently grow just
 * because `Config` does.
 */
export interface ClientConfig {
  /** config.storage.retention.maxAgeMs -- the debug window shared by raw captures, csi_records, and features (docs/architecture.md "Data lifecycle"). */
  retentionMaxAgeMs: number;
  /** Mirrors @homecsi/labeling's DEFAULT_RETENTION_SAFETY_MARGIN_MS -- how far before the edge the CLI already starts warning, so the dashboard can match it rather than inventing its own margin. */
  retentionSafetyMarginMs: number;
}

/**
 * Built-in fallback for callers that don't wire a real `ClientConfig` (e.g.
 * route-level tests with no live config) -- matches config.example.yaml's
 * documented default (7-day debug window), not an arbitrary guess.
 */
export const DEFAULT_RETENTION_MAX_AGE_MS = 604_800_000;

/**
 * `GET /api/config`: the read-only surface a dashboard needs to reason
 * about retention deadlines, without duplicating server-side config
 * loading/parsing on the client. See docs/roadmap.md "Web dashboard" --
 * "The 7-day deadline: a real UX constraint."
 */
export function registerConfigRoutes(app: FastifyInstance, config: ClientConfig): void {
  app.get('/api/config', async () => {
    return {
      retentionMaxAgeMs: config.retentionMaxAgeMs,
      retentionSafetyMarginMs: config.retentionSafetyMarginMs,
    };
  });
}
