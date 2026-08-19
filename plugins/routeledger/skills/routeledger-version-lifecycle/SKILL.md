---
name: routeledger-version-lifecycle
description: Inspect and progress RouteLedger Version lifecycles and route structure. Use when listing Versions, checking start or close gates, planning closeout, preparing or completing a Version, creating, inserting, nesting, reordering, advancing, closing, or force-closing Versions, or executing the exact resulting route-change proposal. Do not use for ordinary Todo, Deferred, or Constraint work.
---

# RouteLedger Version lifecycle

Use the bundled RouteLedger MCP server to inspect and change Version state or route structure. Never edit canonical RouteLedger JSON directly.

## Tools

- Inspect binding: `inspect_runtime(operation="runtime")`.
- Inspect current progress and closeout: `inspect_route_progress`.
- Inspect Version lists, structure, gates, and transition guidance: `inspect_versions`.
- Propose lifecycle changes: `propose_version_lifecycle_change`.
- Propose route-structure changes: `propose_version_structure_change`.
- Prepare or mark implementation complete: `set_version_state`.
- Inspect proposal state when recovering or resuming: `inspect_l3_route_operations`.
- Propose an explicit advanced route change: `propose_l3_route_change`.
- Execute the exact admitted proposal or explicit forced shutdown: `execute_route_change`.

## Preflight

1. Call `inspect_runtime(operation="runtime")` and confirm the active project and RouteLedger root. If the project is unbound or uninitialized, use `routeledger-operator` before continuing.
2. Before every proposal, state write, preview, dry run, or execution, pass the matching absolute `expectedRouteLedgerRoot`.
3. Inspect live Version structure and the relevant start or close gate immediately before proposing a change.

## Choose the workflow

- Use `set_version_state(operation="prepare")` to prepare a waiting Version and `set_version_state(operation="mark_complete")` only after implementation is actually complete.
- Use `propose_version_structure_change` to create, insert, nest, or reorder Versions. On an empty route, create the first real Version; never invent a placeholder.
- Use `propose_version_lifecycle_change` to preview or propose batch creation, transition, advance, or ordinary close.
- Prefer `propose_version_lifecycle_change(operation="propose_version_advance")` when a closed current Version has a ready direct successor.

For closeout, inspect `summarize_version_closeout` or `plan_version_closeout`, clear the named blockers, and review residual work. Declare `{ status: "reviewed", items: [] }` only after confirming no residuals remain; otherwise include every routed item. A summary or plan is evidence, not approval.

Do not insert before closed history, reorder it, change its parent, or add a child beneath it. Append the next real top-level successor when continuing from a closed tail.

## Execute an admitted change

Use the proposal and execution inputs returned by RouteLedger without weakening their project, root, target, action, or digest bindings.

Codex decides whether a high-risk `execute_route_change` call reaches the plugin. Do not reproduce that permission decision in the Skill, infer approval from chat, or manage Codex authorization. Once an admitted call arrives, RouteLedger validates the exact operation and current state, then executes or rejects it.

Use forced shutdown only when the user explicitly requests it and the host admits the high-risk call. If the host denies admission, report the denial and do not simulate the change through another tool or direct file edits.

All canonical changes must remain inside the MCP service boundary and its binding, validation, concurrency, idempotency, and storage safeguards.
