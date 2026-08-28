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

## First-use model

Introduce six concept groups before any advanced details:

1. **Bound Project Context**: RouteLedger operates one bound Project; confirm which Project is active.
2. **Route and Current Version**: the Route is an ordered Version plan, and Current Version is the stage to advance now.
3. **Version Lifecycle**: the normal path is `wait -> ready -> running -> complete -> close`. `complete` means implementation is finished; `close` means blockers, closeout, and residual work are settled.
4. **Work Classification**: Todo is work now, Deferred is reviewed at a named future Version, and Constraint is a rule that must remain true.
5. **Gates and Blockers**: a gate decides whether a transition is allowed; blockers explain why it is not.
6. **Next Action Contract**: `next_action` supplies the recommended tool and exact input, including whether a decision or host admission is required. When `recommendedInputs` identifies a human-review `reason`, write it explicitly in the project's `contentLocale` and add it to the tool input.

Use this routine loop:

```text
confirm binding -> read current context -> get next_action
  -> satisfy any required decision -> execute exact toolInput -> repeat
```

Do not teach route restructuring, exceptional Version states, closeout auditing, Deferred review states, or L3 internals until the matching blocker or next action appears. Never infer executable authorization from ordinary chat or project files. After a timeout, conflict, or unknown result, reread current context and `next_action` before retrying; do not blindly repeat a write.

## Bind and initialize

1. Call `inspect_runtime(operation="runtime")`. Confirm the workspace root, RouteLedger root, active project, storage mode, and `contentLocale`.
2. Surface the Mission Control decision to the user once per task. Use the project's `contentLocale` when paraphrasing it; the raw MCP notice may remain in stable English. Open it only after an explicit user decision; declining the UI never blocks RouteLedger work.
3. If the binding reports `WORKSPACE_ROOT_UNTRUSTED` or `ROUTELEDGER_BINDING_REQUIRED`, obtain the host project's absolute `workspaceRoot`. Never infer it from the plugin cache or process `cwd`.
4. Use `configure_binding` for an explicit binding. Before switching an established binding, show the old and new roots and require confirmation. Re-read runtime state after activation.
5. Use `configure_project(operation="initialize")` only after binding. Include a confirmed concrete BCP 47 `contentLocale`; never send `auto`, `null`, or an invented placeholder Version.

Before every write, pass the matching absolute `expectedRouteLedgerRoot` returned by runtime inspection. Treat binding failures as blockers, not as permission to guess a path.

`contentLocale` applies to agent-authored project content intended for human consumption. Runtime reports this as `scope: project_content_only`. It does not localize MCP control-plane messages, diagnostics, blockers, next actions, or state labels.

Persisted proposal reasons report their provenance as `explicit_input`, `system_default`, or `legacy_unspecified`. Treat a `system_default` reason as stable control-plane metadata, not as localized project content. If a reason will be reviewed by a human, prefer an explicit reason in `contentLocale`; follow `next_action.recommendedInputs` when present.

When `inspect_runtime` reports `interactionProfile: agent_only`, treat Mission Control as advisory. Project initialization omits human-entry-document metadata in this profile; use explicit document inspection only when documentation work is requested.

## Manage current work

Read `inspect_route_progress(operation="get_current_context")` before changing work. Use `currentTodos` for the active Version; `todos` covers all open route Todos and declares that scope under `todoScopes`.

- Use `manage_todo` for work being done in the current Version.
- Use `manage_deferred` for work that must be reviewed by a future Version.
- Use `manage_constraint` for persistent rules that must remain true.

If Deferred work has no eligible downstream Version, follow the returned three-step recovery plan. Propose the Version, execute it after Host admission using the declared result bindings, then inject the proposal's real `targetId` into the original Deferred request. Do not retry against the current Version or an invented ID.

Do not convert Deferred work or Constraints into completion counts. Keep legacy Undo data audit-only.

All canonical writes must pass RouteLedger's binding, validation, concurrency, and storage checks. Skill guidance never replaces those safeguards.
