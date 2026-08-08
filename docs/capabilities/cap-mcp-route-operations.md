# cap-mcp-route-operations

## Scope

This capability covers the MCP operation surface and its server-side safety
rules.

## Current rules

1. Each MCP process has one binding. Discovery and planning tools can inspect
   candidates, but do not switch a running process to a different project.
2. Non-read-only tools require a matching absolute `expectedRouteLedgerRoot`,
   including `dry_run` previews for `transition_version`, `close_version`, and
   `shutdown_version`. Those previews remain write/high-risk MCP operations:
   binding preflight blocks unbound, invalid, or uninitialized operations
   before they enter a write path.
3. Current work is presented as Todo, Deferred, and Constraint. Legacy Undo
   details remain audit-only read data (`includeLegacyUndo=true`) and are not
   part of the agent tool surface; the five legacy Undo tools were removed and
   no write or recommendation surface remains.
4. Deferred work has a target review version; a due item must be reviewed
   rather than silently carried forward. Constraints remain rules, not work
   completion counts.
5. L3 route changes follow proposal, approval or rejection, and commit.
   Commit consumes a valid approval artifact; `confirm=true` alone is not an
   approval. A retry of an already committed operation is a read-like replay
   only when the same consumed artifact still matches the operation ID,
   action, target, and digest exactly; it returns `replayed: true` without
   creating canonical events. Every mismatch fails closed.
6. Route writes use the JSON-first storage boundary and therefore inherit its
   validation, locking, recovery, and conflict behavior.
7. `next_action` follows the version lifecycle: a current `wait` version
   recommends `prepare_version`, while a current `ready` version with a passing
   start gate recommends `start_version`. Gate blockers, due Deferred work,
   pending proposals, shutdown state, and pointer drift retain higher priority.
8. Ordinary version close requires explicit residual-audit evidence. New MCP
   callers use `{ status: "reviewed", items: [] }` to declare a reviewed-empty
   audit; a legacy non-empty item array remains readable, while omitted,
   `null`, and legacy empty arrays remain `MISSING_RESIDUAL_AUDIT`. The same
   resolved evidence (input first, then a pending close proposal) is used by
   gates, closeout summaries/plans, guides, close proposals, and approval
   digests.
9. `responseLocale` controls only human-readable response text for the current
   call (or the server default). Protocol identifiers remain English and
   stable. `get_runtime_context` uses that locale to propose a concrete
   project `contentLocale`, but initialization still requires user
   confirmation and an explicit value. `auto` is invalid.
10. A legacy project whose `contentLocale` is unresolved remains readable.
    All project writes except `set_project_content_locale` are blocked until a
    concrete BCP 47 locale is persisted.
11. `get_runtime_context.contentLocale.effectiveScopes` reports the current
    bounded effect of `contentLocale`: the persisted project setting,
    localized initial-Version defaults, and the write-integrity gate. It does
    not claim translation of user-authored or existing project content.
12. `check_doc_drift` compares explicit Chinese or English declarations of the
    current Version ID, title, and state. It returns every recognized,
    mismatched, and non-detected assertion under `checkedAssertions`, and its
    `coverage.level` remains `partial`; zero warnings never claims complete
    document coverage.

## Evidence

`packages/mcp/src/index.ts`, `binding*.ts`, `input-adapter.ts`, and
`packages/core/src/application/routeledger-service.ts`, together with their
tests, define these guarantees.
