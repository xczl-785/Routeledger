# cap-mcp-runtime-packaging

## Scope

This capability covers local buildable MCP artifacts. It does not publish an
npm package or make a registry availability claim.

## Current rules

1. `pnpm build:mcp-package` creates the full compatibility profile in
   `packages/mcp/dist/`; its runtime includes the UI source launcher required
   by Mission Control and can include the SQLite implementation.
2. `pnpm build:mcp-plugin-runtime` creates the JSON-only profile in
   `packages/mcp/dist-plugin-runtime/`. It has no `sqlite/` bundle and no
   `better-sqlite3` dependency in its package metadata. It carries the built
   read-only UI Hub and exposes the same Mission Control tools as the full
   profile.
3. The JSON-only entry requires `--sqlite-read-model disabled`. It can read and
   write canonical JSON but does not load or create a SQLite database.
4. Both profiles are assembled from the same TypeScript source and import
   rewrite process; the generated launcher supplies an explicit runtime-profile
   marker, and a profile does not introduce a second MCP implementation.
5. Package smoke tests inspect the artifact tree, pack/install it in a
   temporary directory, exercise the stdio protocol, and verify the portable
   UI Hub against canonical JSON without source-workspace dependencies.

## Evidence

`packages/mcp/scripts/build-package.mjs`,
`packages/mcp/scripts/smoke-package.mjs`, and
`packages/mcp/scripts/smoke-package-profiles.mjs` implement these checks.
