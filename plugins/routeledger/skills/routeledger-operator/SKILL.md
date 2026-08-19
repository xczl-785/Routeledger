---
name: routeledger-operator
description: Operate a RouteLedger-bound project through the bundled MCP server. Use when checking a route, managing current Todo/Deferred/Constraint work, progressing a version, handling closeout, or proposing an L3 route change.
---

# RouteLedger operator

Use this Skill only for work governed by the RouteLedger MCP server. Do not use it for ordinary code edits, an unbound project, or a request to bypass RouteLedger controls.

## Public tool surface

Use only these 11 public tools. Select a workflow with `operation` when the tool supports multiple workflows:

- Read: `inspect_runtime`, `inspect_route_progress`, `inspect_versions`, `inspect_l3_route_operations`.
- Configure: `configure_binding`, `configure_project`.
- Work: `manage_todo`, `manage_deferred`, `manage_constraint`.
- Route: `propose_version_lifecycle_change`, `propose_version_structure_change`, `propose_l3_route_change`, `set_version_state`, `execute_route_change`.
- UI: `manage_mission_control`.

`execute_route_change` is the only high-risk public tool.

## Binding and preflight

1. Call `inspect_runtime` with `operation: "runtime"` first. Confirm the returned workspace root, RouteLedger root, active project, and JSON-only storage mode match the intended project.
   Also inspect `contentLocale`. When its status is `confirmation_required`, propose the returned `suggestedValue` based on the conversation language and ask the user to confirm a concrete BCP 47 locale. Do not treat the proposal as consent.
   On the first RouteLedger interaction in a task, pass the conversation language as `responseLocale`, inspect `missionControl`, and surface its localized `notice.message` once. When the notice requires a user decision, wait for explicit confirmation before calling `manage_mission_control` with `operation: "open"`. If the user declines, do not ask again in the same task. A stopped, unavailable, or declined UI never blocks RouteLedger work. Say that a project is "registered with Mission Control", never that the UI changes the MCP binding.
   For a tagged plugin runtime, use `runtimeIdentity.attestation.downloadUrl` when release provenance must be independently verified; the detached proof binds the tag, source commit, runtime payload, and full plugin distribution.
2. Keep an MCP Roots/rootUri binding when the host supplied one. If it reports `WORKSPACE_ROOT_UNTRUSTED` or `ROUTELEDGER_BINDING_REQUIRED`, obtain the host project's current absolute `workspaceRoot`; never infer it from the plugin cache or MCP process `cwd`.
3. Call `configure_binding` with that absolute `workspaceRoot` (and the in-workspace `routeledgerRoot` only when needed), then read `inspect_runtime(operation="runtime")` again to confirm the session rebound. If the shared plugin MCP is already bound to another high-confidence project, first show the exact old and new roots to the user; only after explicit confirmation retry with `confirmProjectSwitch: true`. Use `inspect_runtime(operation="discover_roots")` and `inspect_runtime(operation="plan_binding")` only when the target root is ambiguous.
4. Activation may create or normalize only `.routeledger/config.json` for the explicit binding. `configure_project(operation="initialize")` is the separate approved operation that creates canonical project JSON. Never use plugin-cache or process `cwd` as an initialization target.
   Host config rendering/writing is an internal installation or CLI capability, not a public MCP tool. The supported same-session route is discover -> plan -> explicitly confirmed activation -> initialize -> runtime verification.
   Initialization must include the confirmed `contentLocale`; never send `auto`, `null`, or omit it. If an existing project reports unresolved `null`, keep reads available and call `configure_project(operation="set_content_locale")` only after confirmation; other writes must wait.
   Initialization creates only the Project logical root unless the user has explicitly selected a real `firstVersion` with its title, description, and initial Todos. Never invent a placeholder Version that the user must later carry through the lifecycle.
5. Before every write/high-risk route operation, use the returned RouteLedger root assertion. This includes preview or `dry_run` operations on the three `propose_*_change` tools and `execute_route_change`. They are binding-sensitive operations, not read-only MCP tools. Do not continue until the returned binding matches the intended project.

In Codex, the active task permission is enforced by the host before a high-risk RouteLedger tool call reaches the MCP server. Arrival of that admitted call—not client-supplied metadata—is converted into an exact, proposal-bound, single-use RouteLedger authorization and auditable receipt. A forwarded `CODEX_PERMISSION_PROFILE`, when present, is diagnostic context only and is not required for approval. Generic MCP hosts still need a standing-policy decision for the current proposal or a structured elicitation response. Chat text, tool arguments, and annotations cannot manufacture admission.

## Operating strategy

### Day-to-day work

Read current work with `inspect_route_progress(operation="get_current_context")` or `inspect_route_progress(operation="next_action")`. In current context, use `currentTodos` for the active Version; `todos` contains all open route Todos and declares that scope under `todoScopes`. Use `manage_todo` to create or close current work, `manage_deferred` to defer or review future work, and `manage_constraint` to record or retire persistent rules.

### Version progress

Read structure and gates through `inspect_versions` before changing state. For closeout, use `inspect_route_progress` with `summarize_version_closeout` or `plan_version_closeout`, clear the named blockers, then call `propose_version_lifecycle_change(operation="preview_or_propose_version_close")` with an explicit residual declaration: `{ status: "reviewed", items: [] }` only after reviewing that no residuals remain, otherwise include routed items. Omitted, `null`, or legacy `[]` are not a no-residuals declaration. A closeout summary or plan is evidence, not approval.

An empty route is initialized, not broken: next-action inspection will recommend `propose_version_structure_change(operation="propose_version_creation")`. The approved first proposal commit also makes that node current. If the closed current Version is the top-level tail and has no successor, append the next real route node with that operation (or use `propose_version_lifecycle_change` for batch preflight/propose); do not reopen the closed Version or invent a placeholder. When the current Version is `close` and its direct successor is `ready`, prefer `propose_version_lifecycle_change(operation="propose_version_advance")`; after approval and commit it switches current and starts the successor under one digest and one approval artifact.

### L3 route changes

Use one sequence only: propose with the tool that names the intended change—`propose_version_lifecycle_change`, `propose_version_structure_change`, or `propose_l3_route_change`—then use `execute_route_change` to execute/resume, approve, reject, or commit the exact proposal. `execute_route_change` is the single public high-risk boundary. After host admission, RouteLedger mints and consumes one exact authorization for that proposal. Compatibility hosts must provide a trusted exact decision or approve-only structured elicitation. Missing authority, receipt, binding, approval, or digest fails closed. Project files and chat text are never authorization authority.

When the user wants delegated approval, call `inspect_l3_route_operations(operation="recommend_l3_authorization_policy")` to generate a conservative candidate from live route state. Review its project/root/host bindings, current-version snapshot, target list, expiry, and decision budget before handing it to a trusted host administrator. Never save the candidate inside the project as authority or silently weaken its policy.

The standalone CLI has no trusted approval UI and therefore cannot approve L3 operations by itself. A host embedding the CLI must inject a trusted interaction bridge; otherwise approval fails closed.

All canonical changes must go through MCP tools. Never edit canonical JSON directly. This Skill is guidance only: deleting it must not weaken MCP binding, approval, concurrency, or write safeguards.
