# @routeledger/mcp

Local json-only artifact for the RouteLedger MCP stdio server.

## Status

- This artifact is generated locally from the RouteLedger workspace.
- It is not a published npm package and should not be documented as registry-ready.
- Internal RouteLedger workspace packages are compiled into the dist artifact.
- This JSON-only artifact has no `better-sqlite3` dependency and carries neither SQLite nor UI runtime bundles. It must be started with `--sqlite-read-model disabled`; its entry rejects a missing or different value.

## Build

```bash
cd /ABS/PATH/TO/ROUTELEDGER_REPO_ROOT
pnpm build:mcp-plugin-runtime
```

The generated package version is `0.0.0-package-prep`.

## Local tarball smoke

```bash
cd /ABS/PATH/TO/ROUTELEDGER_REPO_ROOT
pnpm smoke:mcp-plugin-runtime
```

That smoke flow builds the generated artifact, runs `npm pack`, installs the tarball into a temporary directory, and verifies `initialize -> tools/list` against temporary workspace and RouteLedger roots.

## Host usage after local install

Example command:

```bash
node /ABS/PATH/TO/install-root/node_modules/@routeledger/mcp/bin.js \
  --workspace-root /ABS/PATH/TO/MANAGED_WORKSPACE_ROOT \
  --routeledger-root /ABS/PATH/TO/MANAGED_WORKSPACE_ROOT \
  --profile codex \
  --sqlite-read-model disabled
```

Keep `--workspace-root` and `--routeledger-root` explicit. Do not rely on `cwd` fallback.
