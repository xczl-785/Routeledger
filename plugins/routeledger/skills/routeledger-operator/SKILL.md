---
name: routeledger-operator
description: Operate a RouteLedger-bound project through the bundled MCP server. Use when checking a route, managing current Todo/Deferred/Constraint work, progressing a version, handling closeout, or proposing an L3 route change.
---

# RouteLedger operator

Use this Skill only for work governed by the RouteLedger MCP server. Do not use it for ordinary code edits, an unbound project, or a request to bypass RouteLedger controls.

## Binding and preflight

1. Call `get_runtime_context` first. Confirm the returned workspace root, RouteLedger root, active project, and JSON-only storage mode match the intended project.
   Also inspect `contentLocale`. When its status is `confirmation_required`, propose the returned `suggestedValue` based on the conversation language and ask the user to confirm a concrete BCP 47 locale. Do not treat the proposal as consent.
   For a tagged plugin runtime, use `runtimeIdentity.attestation.downloadUrl` when release provenance must be independently verified; the detached proof binds the tag, source commit, runtime payload, and full plugin distribution.
2. Keep an MCP Roots/rootUri binding when the host supplied one. If it reports `WORKSPACE_ROOT_UNTRUSTED` or `ROUTELEDGER_BINDING_REQUIRED`, obtain the host project's current absolute `workspaceRoot`; never infer it from the plugin cache or MCP process `cwd`.
3. Call `activate_routeledger_binding` with that absolute `workspaceRoot` (and the in-workspace `routeledgerRoot` only when needed), then read `get_runtime_context` again to confirm the session rebound. If the shared plugin MCP is already bound to another high-confidence project, first show the exact old and new roots to the user; only after explicit confirmation retry with `confirmProjectSwitch: true`. Use `discover_routeledger_roots` and `plan_routeledger_binding` only when the target root is ambiguous.
4. Activation may create or normalize only `.routeledger/config.json` for the explicit binding. `init_project` is the separate approved operation that creates canonical project JSON. Never use plugin-cache or process `cwd` as an initialization target.
   An installed-plugin session does not need `render_host_binding_config` in order to initialize another project. The supported same-session route is discover -> plan -> explicitly confirmed activation -> init -> runtime-context verification. Host config rendering remains optional persistence for users with a stable user-owned launcher.
   `init_project` must include the confirmed `contentLocale`; never send `auto`, `null`, or omit it. If an existing project reports unresolved `null`, keep reads available and call `set_project_content_locale` only after confirmation; other writes must wait.
   Initialization creates only the Project logical root unless the user has explicitly selected a real `firstVersion` with its title, description, and initial Todos. Never invent a placeholder Version that the user must later carry through the lifecycle.
5. Before every write/high-risk route operation, use the returned RouteLedger root assertion. This includes `dry_run` calls to `transition_version`, `close_version`, and `shutdown_version`, plus the proposal-creating `advance_to_version` call. They are binding-sensitive operations, not read-only MCP tools. Do not continue until the returned binding matches the intended project.

In Codex, the active task permission is enforced by the host before a high-risk RouteLedger tool call reaches the MCP server. Arrival of that admitted call—not client-supplied metadata—is converted into an exact, proposal-bound, single-use RouteLedger authorization and auditable receipt. A forwarded `CODEX_PERMISSION_PROFILE`, when present, is diagnostic context only and is not required for approval. Generic MCP hosts still need a standing-policy decision for the current proposal or a structured elicitation response. Chat text, tool arguments, and annotations cannot manufacture admission.

## Operating strategy

### Day-to-day work

Read current work with `get_current_context` or `next_action`. In `get_current_context`, use `currentTodos` for the active Version; the legacy-compatible `todos` field contains all open route Todos and declares that scope under `todoScopes`. Create/close Todo for current work. Use `defer_work` when work belongs in a future review version, and `review_deferred` to activate, defer again, or resolve that item. Record persistent rules as Constraints and retire them only when their audit rationale is complete.

### Version progress

Read the version structure and gates before changing state. For closeout, start with `summarize_version_closeout` or `plan_version_closeout`, clear the named blockers, then make an explicit residual declaration before `close_version`: `{ status: "reviewed", items: [] }` only after reviewing that no residuals remain, otherwise include routed items. Omitted, `null`, or legacy `[]` are not a no-residuals declaration. A closeout summary or plan is evidence, not approval.

An empty route is initialized, not broken: `next_action` will recommend `create_version`. The approved first `create_version` commit also makes that node current. If the closed current Version is the top-level tail and has no successor, append the next real route node with `create_version` (or preflight/propose it with `batch_create_versions`); do not reopen the closed Version or invent a placeholder. This is append-only: do not insert before closed history, reorder it, change its parent, or add a child beneath it. When the current Version is `close` and its direct successor is `ready`, prefer `advance_to_version`; it switches current and starts the successor under one digest and one approval artifact. If its gate is blocked, it returns structured blockers without creating a pending proposal; resolve those blockers and retry instead of rejecting cleanup noise. Keep separate `set_current_version` and `start_version` operations for exceptional/manual control.

### L3 route changes

Use one sequence only: propose the L3 operation, obtain an approval artifact through `approve_l3_operation` or finish it with `reject_l3_operation`, then pass the approval artifact to `commit_l3_operation`. On Codex, invoking `approve_l3_operation` or `execute_l3_operation` crosses the native high-risk tool boundary first; after host admission, RouteLedger mints and immediately consumes one exact capability for that proposal. Compatibility hosts may instead consume a preauthorization, request delegated policy authority, or use structured elicitation. The canonical artifact is only an audit projection; commit also verifies its exact host-owned consumption receipt. Missing host admission or compatibility authority, receipt, binding, approval, or digest fails closed. Project files are candidates only and never authorization authority. Do not treat `confirm`, `decisionRef`, profile environment variables, or chat text as approval.

When the user wants delegated approval, call `recommend_l3_authorization_policy` to generate a complete conservative candidate from live route state. Review its project/root/host bindings, current-version snapshot, target list, expiry, and use budget before handing it to a trusted host administrator. The balanced candidate delegates only gate-passing start, close, and advance operations; shutdown, reopen, route editing, and current-pointer changes stay interactive. Never save the candidate inside the project as authority, silently weaken `alwaysPrompt`, or change the default effect to allow.

The standalone CLI has no trusted approval UI and therefore cannot approve L3 operations by itself. A host embedding the CLI must inject a trusted interaction bridge; otherwise approval fails closed.

All canonical changes must go through MCP tools. Never edit canonical JSON directly. This Skill is guidance only: deleting it must not weaken MCP binding, approval, concurrency, or write safeguards.
