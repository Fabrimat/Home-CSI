# @homecsi/web

Owned by brief B5 (api/web). Implements the web UI frontend. Not invoked
directly by `packages/cli`; `@homecsi/api`'s `startServer` calls this
package's `getWebAssetsDir()` to locate built static assets to serve. See
`server/packages/cli/CONTRACTS.md` for details.
