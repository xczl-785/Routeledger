# cap-sqlite-read-model-truth-source-boundary

## Scope

This capability defines the SQLite compatibility boundary and the canonical
JSON authority used by the MCP runtime.

## Current rules

1. `SQLiteStorageAdapter` persists and validates a complete aggregate for one
   project; its schema is exercised by `packages/sqlite/src/testing/`.
2. When canonical JSON exists, `JsonFirstStorageAdapter` loads and validates it
   before consulting SQLite. A JSON/SQLite disagreement is reported as an
   explicit conflict rather than silently overwritten.
3. MCP writes canonical JSON first. With the enabled read model, SQLite sync is
   a follow-up operation and a sync failure does not undo the canonical write.
4. The JSON-only plugin runtime always disables the SQLite read model. It does
   not load, create, or package the SQLite implementation.
5. The repository ignores its own root `/.routeledger/` runtime state. The
   controlled canonical fixture at
   `packages/json/src/testing/fixtures/canonical/.routeledger/` remains
   tracked and is part of validation tests.

## Evidence

`packages/mcp/src/json-first-storage.ts`,
`packages/sqlite/src/sqlite-storage-adapter.ts`, and the corresponding MCP,
SQLite, and JSON test suites define the executable contract.
