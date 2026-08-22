import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Returns the absolute path to this package's built static assets
 * (index.html, JS/CSS bundles), for `@homecsi/api` to serve via
 * `@fastify/static`. Not a CLI command — `@homecsi/api`'s `startServer`
 * calls this directly. Owned by brief B5, which also decides the actual
 * frontend build tooling (this repo does not prescribe one).
 *
 * The frontend app lives under `ui/` (built by Vite, see `npm run build` in
 * this package) rather than under `src/` — `src/` is the small Node-side
 * surface compiled by the workspace's `tsc -b`, kept deliberately separate
 * from the browser-targeted UI sources so the two don't share a tsconfig
 * (the UI needs the DOM lib; this file must not).
 */
export function getWebAssetsDir(): string {
  // dist/index.js (this file, compiled) sits at packages/web/dist/index.js;
  // Vite's configured build.outDir is packages/web/ui-dist.
  return path.resolve(__dirname, '../ui-dist');
}
