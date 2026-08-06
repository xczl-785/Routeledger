# cap-json-first-runtime-storage

## Scope

This capability describes how the MCP runtime resolves a binding, loads its
state, serializes writes, and treats the optional SQLite read model.

## Current rules

1. A binding supplies a `workspaceRoot` and a `routeledgerRoot` inside that
   workspace. `.routeledger/config.json` at the project root resolves the
   physical `dataRoot`; canonical documents live at
   `<dataRoot>/.routeledger/`.
2. If canonical `project.json` exists, it is decoded and validated as the
   runtime authority. A missing or invalid JSON set is never silently replaced
   by a conflicting SQLite snapshot.
3. With `sqliteReadModel: "enabled"`, a configured SQLite-only project remains
   a compatibility input. With `"disabled"`, the runtime does not load it and
   reports the project as uninitialized until canonical JSON exists.
4. `saveProjectAggregate()` writes canonical JSON before attempting optional
   SQLite synchronization. JSON survives a read-model failure.
5. A write lock and canonical-head revision protect save operations. Active
   competing reads/writes return `WRITE_IN_PROGRESS`; an obsolete snapshot save
   returns `STALE_SNAPSHOT`.

## Evidence

The executable contract is in `packages/mcp/src/json-first-storage.ts`,
`packages/mcp/src/workspace-config.ts`, `packages/json/src/filesystem.ts`, and
the MCP and JSON test suites.
