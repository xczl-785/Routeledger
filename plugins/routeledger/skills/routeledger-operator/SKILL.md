---
name: routeledger-operator
description: Operate a RouteLedger-bound project through the bundled MCP server. Use when checking a route, managing current Todo/Deferred/Constraint work, progressing a version, handling closeout, or proposing an L3 route change.
---

# RouteLedger operator

Use this Skill only for work governed by the RouteLedger MCP server. Do not use it for ordinary code edits, an unbound project, or a request to bypass RouteLedger controls.

## Binding and preflight

1. Call `get_runtime_context` first. Confirm the returned workspace root, RouteLedger root, active project, and JSON-only storage mode match the intended project.
2. Keep an MCP Roots/rootUri binding when the host supplied one. If the binding is unbound, invalid, or only `process_cwd`/low confidence, obtain the host project's absolute `workspaceRoot`.
3. Use `discover_routeledger_roots` and `plan_routeledger_binding` only to inspect and plan an explicit workspace. Then use `activate_routeledger_binding` when the host offers its approval workflow.
4. Activation may create or normalize only `.routeledger/config.json` for the explicit binding. `init_project` is the separate approved operation that creates canonical project JSON. Never use plugin-cache or process `cwd` as an initialization target.
5. Before every canonical write, use the returned RouteLedger root assertion. Do not continue a write until the returned binding matches the intended project.

Host approval metadata is an operator-flow hint, not a server-enforced prompt or a replacement for RouteLedger binding and L3 safeguards.

## Operating strategy

### Day-to-day work

Read current work with `get_current_context` or `next_action`. Create/close Todo for current work. Use `defer_work` when work belongs in a future review version, and `review_deferred` to activate, defer again, or resolve that item. Record persistent rules as Constraints and retire them only when their audit rationale is complete.

### Version progress

Read the version structure and gates before changing state. For closeout, start with `summarize_version_closeout` or `plan_version_closeout`, clear the named blockers, then use the close workflow. A closeout summary or plan is evidence, not approval.

### L3 route changes

Use one sequence only: propose the L3 operation, obtain an approval artifact through `approve_l3_operation` or finish it with `reject_l3_operation`, then pass the approval artifact to `commit_l3_operation`. Do not treat `confirm` or chat text as an approval artifact. `shutdown_version` is the exceptional forced path and needs its explicit forced-path rationale.

All canonical changes must go through MCP tools. Never edit canonical JSON directly. This Skill is guidance only: deleting it must not weaken MCP binding, approval, concurrency, or write safeguards.
