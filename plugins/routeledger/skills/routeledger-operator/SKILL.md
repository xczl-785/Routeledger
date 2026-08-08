---
name: routeledger-operator
description: Operate a RouteLedger-bound project through the bundled MCP server. Use when checking a route, managing current Todo/Deferred/Constraint work, progressing a version, handling closeout, or proposing an L3 route change.
---

# RouteLedger operator

Use this Skill only for work governed by the RouteLedger MCP server. Do not use it for ordinary code edits, an unbound project, or a request to bypass RouteLedger controls.

## Binding and preflight

1. Call `get_runtime_context` first. Confirm the returned workspace root, RouteLedger root, active project, and JSON-only storage mode match the intended project.
   Also inspect `contentLocale`. When its status is `confirmation_required`, propose the returned `suggestedValue` based on the conversation language and ask the user to confirm a concrete BCP 47 locale. Do not treat the proposal as consent.
2. Keep an MCP Roots/rootUri binding when the host supplied one. If it reports `WORKSPACE_ROOT_UNTRUSTED` or `ROUTELEDGER_BINDING_REQUIRED`, obtain the host project's current absolute `workspaceRoot`; never infer it from the plugin cache or MCP process `cwd`.
3. Call `activate_routeledger_binding` with that absolute `workspaceRoot` (and the in-workspace `routeledgerRoot` only when needed), then read `get_runtime_context` again to confirm the session rebound. Use `discover_routeledger_roots` and `plan_routeledger_binding` only when the target root is ambiguous.
4. Activation may create or normalize only `.routeledger/config.json` for the explicit binding. `init_project` is the separate approved operation that creates canonical project JSON. Never use plugin-cache or process `cwd` as an initialization target.
   `init_project` must include the confirmed `contentLocale`; never send `auto`, `null`, or omit it. If an existing project reports unresolved `null`, keep reads available and call `set_project_content_locale` only after confirmation; other writes must wait.
5. Before every write/high-risk route operation, use the returned RouteLedger root assertion. This includes `dry_run` calls to `transition_version`, `close_version`, and `shutdown_version`: they are binding-sensitive previews, not read-only MCP tools. Do not continue until the returned binding matches the intended project.

Host approval metadata is an operator-flow hint, not a server-enforced prompt or a replacement for RouteLedger binding and L3 safeguards.

## Operating strategy

### Day-to-day work

Read current work with `get_current_context` or `next_action`. Create/close Todo for current work. Use `defer_work` when work belongs in a future review version, and `review_deferred` to activate, defer again, or resolve that item. Record persistent rules as Constraints and retire them only when their audit rationale is complete.

### Version progress

Read the version structure and gates before changing state. For closeout, start with `summarize_version_closeout` or `plan_version_closeout`, clear the named blockers, then make an explicit residual declaration before `close_version`: `{ status: "reviewed", items: [] }` only after reviewing that no residuals remain, otherwise include routed items. Omitted, `null`, or legacy `[]` are not a no-residuals declaration. A closeout summary or plan is evidence, not approval.

### L3 route changes

Use one sequence only: propose the L3 operation, obtain an approval artifact through `approve_l3_operation` or finish it with `reject_l3_operation`, then pass the approval artifact to `commit_l3_operation`. Do not treat `confirm` or chat text as an approval artifact. `shutdown_version` is the exceptional forced path and needs its explicit forced-path rationale.

All canonical changes must go through MCP tools. Never edit canonical JSON directly. This Skill is guidance only: deleting it must not weaken MCP binding, approval, concurrency, or write safeguards.
