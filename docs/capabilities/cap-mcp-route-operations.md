# cap-mcp-route-operations

## Scope

This capability covers the MCP operation surface and its server-side safety
rules.

## Current rules

1. Each MCP process has one binding. Discovery and planning tools can inspect
   candidates, but do not switch a running process to a different project.
2. Non-read-only tools require a matching absolute `expectedRouteLedgerRoot`.
   Binding preflight blocks unbound, invalid, or uninitialized operations
   before they enter a write path.
3. Current work is presented as Todo, Deferred, and Constraint. Legacy Undo
   details remain compatibility/audit data and are not the default agent work
   surface.
4. Deferred work has a target review version; a due item must be reviewed
   rather than silently carried forward. Constraints remain rules, not work
   completion counts.
5. L3 route changes follow proposal, approval or rejection, and commit.
   Commit consumes a valid approval artifact; `confirm=true` alone is not an
   approval.
6. Route writes use the JSON-first storage boundary and therefore inherit its
   validation, locking, recovery, and conflict behavior.

## Evidence

`packages/mcp/src/index.ts`, `binding*.ts`, `input-adapter.ts`, and
`packages/core/src/application/routeledger-service.ts`, together with their
tests, define these guarantees.
