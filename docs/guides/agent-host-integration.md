# Agent-host integration

RouteLedger is an MCP stdio control plane. One running server binds one
managed RouteLedger root inside one workspace; it is not a runtime project
switcher.

## Binding model

Use explicit placeholder paths:

```text
workspaceRoot   = /ABS/PATH/TO/WORKSPACE
routeledgerRoot = /ABS/PATH/TO/WORKSPACE/RELATIVE/PATH/TO/MANAGED_PROJECT
runtime source  = /ABS/PATH/TO/ROUTELEDGER_REPO_ROOT
```

`routeledgerRoot` must be inside `workspaceRoot`. The single-root case is
valid when both paths are the same. The managed project's
`.routeledger/config.json` resolves `dataRoot`; canonical data is stored at
`<dataRoot>/.routeledger/`. The runtime source directory and process `cwd`
never select the managed project.

For source mode, adapt the repository example in
`examples/config/codex.config.toml`:

```bash
pnpm --filter @routeledger/mcp exec tsx src/bin.ts \
  --workspace-root /ABS/PATH/TO/WORKSPACE \
  --routeledger-root /ABS/PATH/TO/WORKSPACE/RELATIVE/PATH/TO/MANAGED_PROJECT \
  --profile codex
```

The process must run with `cwd` set to
`/ABS/PATH/TO/ROUTELEDGER_REPO_ROOT`. Other MCP hosts can use the same stdio
arguments and select an appropriate supported profile.

## First use and existing data

Call `get_runtime_context` before planning or writing. It returns the active
binding and storage mode. For an empty intended project, use the normal
preflight flow and initialize only after confirming the returned root. For an
existing canonical data set, read it before writing. When JSON and SQLite
disagree, stop on `JSON_SQLITE_CONFLICT`; do not delete either store to force
a result.

Canonical JSON is the MCP runtime authority. SQLite is a rebuildable read
model when enabled. The JSON-only plugin runtime disables that read model and
does not create a database.

## Multiple projects

Run one entry per managed project, for example `routeledger_project_a` and
`routeledger_project_b`. Entries can share the same source checkout or
installed runtime, but they are separate processes and bindings. Do not use a
single entry to alternate roots between calls.

## Safety

Read-only inspection may be automated according to host policy. Keep normal
writes prompted, and require the strongest available confirmation for
`commit_l3_operation`. The server independently checks binding preflight,
`expectedRouteLedgerRoot`, canonical storage rules, and approval artifacts;
host approval UI does not replace those checks.
