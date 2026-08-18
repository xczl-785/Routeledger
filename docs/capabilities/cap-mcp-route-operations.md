# cap-mcp-route-operations

## Scope

This capability covers the MCP operation surface and its server-side safety
rules.

## Current rules

1. Each MCP process has one binding. Discovery and planning tools can inspect
   candidates, but do not switch a running process to a different project.
2. Non-read-only tools require a matching absolute `expectedRouteLedgerRoot`,
   including `dry_run` operations on `propose_route_change` and
   `execute_route_change`. Those previews remain
   write/high-risk MCP operations:
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
   Approval artifacts are minted only after a trusted exact decision from
   structured host elicitation, Codex native admission, or a host-managed
   standing policy evaluated for the current proposal. Project files are never authority: the canonical approval artifact is an audit projection, while
   `execute_route_change(operation="commit_l3_operation")` verifies an exact host-owned consumption receipt bound to the artifact ID, proposal
   digest, authorization, root, and provenance. Invalid authorization or receipts and unsupported interaction fail closed; the
   standalone CLI cannot self-approve. Commit consumes a valid approval
   artifact; `confirm=true` alone is not an approval. A retry of an already committed operation is a read-like replay
   only when the same consumed artifact still matches the operation ID,
   action, target, and digest exactly; it returns `replayed: true` without
   creating canonical events. Every mismatch fails closed.
6. Route writes use the JSON-first storage boundary and therefore inherit its
   validation, locking, recovery, and conflict behavior.
7. `inspect_route(operation="next_action")` follows the version lifecycle: a current `wait` version
   recommends `set_version_state(operation="prepare")`, while a current `ready` version with a passing
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
   stable. `inspect_runtime(operation="runtime")` uses that locale to propose a concrete
   project `contentLocale`, but initialization still requires user
   confirmation and an explicit value. `auto` is invalid.
10. A legacy project whose `contentLocale` is unresolved remains readable.
   All project writes except `configure_project(operation="set_content_locale")` are blocked until a
    concrete BCP 47 locale is persisted.
11. `inspect_runtime(operation="runtime").contentLocale.effectiveScopes` reports the current
    bounded effect of `contentLocale`: the persisted project setting, the
    default language agents should use for new project content, and the
    write-integrity gate. It does
    not claim translation of user-authored or existing project content.
12. `inspect_route(operation="check_doc_drift")` compares explicit Chinese or English declarations of the
    current Version ID, title, and state. It returns every recognized,
    mismatched, and non-detected assertion under `checkedAssertions`, and its
    `coverage.level` remains `partial`; zero warnings never claims complete
    document coverage.
13. `configure_project(operation="initialize")` distinguishes project initialization from route selection.
    Omitting `firstVersion` creates a valid empty route with nullable current
    and legacy-initial pointers. An explicit `firstVersion` creates the first
    current `wait` node and its `initialTodos` in the same aggregate write.
14. On an empty route, the first approved `propose_route_change(operation="propose_version_creation")` commit creates the
    node and assigns it as current atomically. Batch creation requires an
    explicit `setCurrentTo`. A closed top-level tail may receive an append-only
    successor through single or batch creation without reopening or replacing
    that historical node; insertion before closed history, reordering it,
    changing its parent, and adding children beneath it remain forbidden. The
    continuation records `version.successor_appended`. For ordinary forward progress from a closed
    current Version to its ready direct successor, `propose_route_change(operation="propose_version_advance")`
    performs current-switch and start under one proposal, digest, approval
    artifact, operation ID, and aggregate save. A blocked gate returns
    structured blockers without creating a pending proposal.
15. Pending-operation persistence is verified before a proposal is returned for
    approval: canonical payload/gate bytes must rebuild the stored digest after
    reload. A lossy adapter fails early and the new proposal is rolled back.
    Equal-timestamp Todos created by one batch retain their explicit input
    order through their creation-event sequence.
16. The public registry exposes exactly 11 task-level tools. Multi-operation
    tools select behavior with `operation`; business fields named `action`
    remain available without colliding with dispatch. Former tool names are not
    public aliases. They remain internal capability registrations only, and
    persisted L3 `actionType` values do not change.
17. The public risk split is 2 read-only tools (`inspect_runtime`,
    `inspect_route`), 8 ordinary write tools, and one high-risk tool
    (`execute_route_change`). Host binding config rendering/writing remains an
    internal/CLI installation capability rather than an Agent-facing MCP tool.

## Evidence

`packages/mcp/src/index.ts` remains the public facade and composition root.
Ordered tool registrations and handlers live in
`packages/mcp/src/capabilities/*.ts`; shared tool contracts and transport
schemas live in `packages/mcp/src/registry/*.ts` and
`packages/mcp/src/l3-authorization-contract.ts`. `binding*.ts`,
`input-adapter.ts`, `packages/core/src/application/routeledger-service.ts`,
`packages/core/src/application/version-closeout-application.ts`, and their
tests together define these guarantees. `RouteLedgerService` remains the
public application facade and retains aggregate loading/ownership validation;
the closeout collaborator is read-only orchestration behind that facade.
