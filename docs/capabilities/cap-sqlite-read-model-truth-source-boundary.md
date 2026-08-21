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
6. SQLite stores a monotonic `projects.aggregate_revision` (migration `0010`).
   Its load token is `sqlite:<revision>` and save compares/increments it in one
   immediate transaction, so two adapter instances cannot both commit a stale
   aggregate. A new aggregate expects `null` and commits non-empty revision
   `sqlite:1`; `null` is never a successful writer result.
7. Canonical JSON hashes and SQLite revisions are separate token domains. JSON
   to SQLite synchronization loads SQLite's current token before persisting the
   read model; it never sends the JSON hash as SQLite's expected revision or
   overwrites the canonical snapshot's JSON revision.

## Evidence

`packages/mcp/src/json-first-storage.ts`,
`packages/sqlite/src/sqlite-storage-adapter.ts`, and the corresponding MCP,
SQLite, and JSON test suites define the executable contract.
