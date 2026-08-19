---
name: routeledger-operator
description: Operate a RouteLedger project for runtime checks, binding, initialization, Mission Control, and current Todo, Deferred, or Constraint work. Use when setting up RouteLedger, checking current context or the next action, or managing day-to-day work. Use routeledger-version-lifecycle instead for Version structure, gates, transitions, or closeout.
---

# RouteLedger operator

Operate only through the bundled RouteLedger MCP server. Never edit canonical RouteLedger JSON directly.

## Tools

- Inspect runtime and binding: `inspect_runtime`.
- Bind or initialize: `configure_binding`, `configure_project`.
- Inspect current work: `inspect_route_progress` with `get_current_context`, `next_action`, or `check_doc_drift`.
- Manage work: `manage_todo`, `manage_deferred`, `manage_constraint`.
- Open or stop the local read-only UI: `manage_mission_control`.

Use `routeledger-version-lifecycle` for Version lists, structure, gates, closeout, lifecycle proposals, or route-change execution.

## Bind and initialize

1. Call `inspect_runtime(operation="runtime")`. Confirm the workspace root, RouteLedger root, active project, storage mode, and `contentLocale`.
2. Surface the localized Mission Control notice once per task. Open it only after an explicit user decision; declining the UI never blocks RouteLedger work.
3. If the binding reports `WORKSPACE_ROOT_UNTRUSTED` or `ROUTELEDGER_BINDING_REQUIRED`, obtain the host project's absolute `workspaceRoot`. Never infer it from the plugin cache or process `cwd`.
4. Use `configure_binding` for an explicit binding. Before switching an established binding, show the old and new roots and require confirmation. Re-read runtime state after activation.
5. Use `configure_project(operation="initialize")` only after binding. Include a confirmed concrete BCP 47 `contentLocale`; never send `auto`, `null`, or an invented placeholder Version.

Before every write, pass the matching absolute `expectedRouteLedgerRoot` returned by runtime inspection. Treat binding failures as blockers, not as permission to guess a path.

## Manage current work

Read `inspect_route_progress(operation="get_current_context")` before changing work. Use `currentTodos` for the active Version; `todos` covers all open route Todos and declares that scope under `todoScopes`.

- Use `manage_todo` for work being done in the current Version.
- Use `manage_deferred` for work that must be reviewed by a future Version.
- Use `manage_constraint` for persistent rules that must remain true.

If Deferred work has no eligible downstream Version, follow the returned `propose_downstream_version` action. Complete the Version proposal approval flow before retrying Deferred creation; do not retry against the current Version or an invented ID.

Do not convert Deferred work or Constraints into completion counts. Keep legacy Undo data audit-only.

All canonical writes must pass RouteLedger's binding, validation, concurrency, and storage checks. Skill guidance never replaces those safeguards.
