---
name: routeledger-operator
description: Operate a RouteLedger-bound project through the bundled MCP server. Use when checking a route, managing current Todo/Deferred/Constraint work, progressing a version, handling closeout, or proposing an L3 route change.
---

# RouteLedger operator

Use this Skill only for work governed by the RouteLedger MCP server. Do not use it for ordinary code edits, an unbound project, or a request to bypass RouteLedger controls.

## Preflight

Call `get_runtime_context` first. Confirm the returned workspace root, RouteLedger root, active project, and JSON-only storage mode match the intended project. If binding is unbound, invalid, or surprising, stop and explain the mismatch. Do not infer a different root from `cwd`, call a root-switch operation, or continue a write.

## Operating strategy

- Bootstrap an empty bound project with `init_project` only after preflight; send the returned RouteLedger-root assertion on writes.
- Read current work with `get_current_context` or `next_action`; create/close Todo, defer/review Deferred work, and record/retire Constraints through their MCP tools.
- For version progress, read the version structure and gates before transition or closeout; use the closeout planning/read tools to resolve blockers rather than treating a summary as approval.
- For an L3 route change, use the proposal, approval/reject, and commit sequence. Do not treat `confirm` or chat text as an approval artifact.

All canonical changes must go through MCP tools. Never edit canonical JSON directly. This Skill is guidance only: deleting it must not weaken MCP binding, approval, concurrency, or write safeguards.
