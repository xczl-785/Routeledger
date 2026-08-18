# New MCP tool checklist

Adding a tool to the MCP surface changes more than the handler. Run this
checklist for every new tool.

## Registry and contract

1. Register the tool with `defineTool(...)` in the matching
   `packages/mcp/src/capabilities/*-tools.ts` factory. Keep
   `packages/mcp/src/index.ts` responsible for explicit cross-capability order,
   runtime composition, profile filtering, and the public facade. Schema
   validation, risk metadata, `expectedRouteLedgerRoot` injection, binding
   preflight, and debug hooks still come from the registry.
2. Update the tool budget assertions in
   `packages/mcp/src/testing/tool-description-contract.test.ts` (currently
   49 tools: 21 read-only / 23 write / 5 high-risk). The budget is a
   deliberate gate against silent surface growth.
3. Classify annotations from actual effects, not from apparent product intent.
   `readOnlyHint` is true only when the tool cannot change state;
   `destructiveHint` covers deletion, overwrite, or outcomes that are
   irreversible or difficult to reverse; `openWorldHint` covers publishing or
   affecting public/external systems. Set `idempotentHint` only when repeating
   the same arguments has no additional effect. These hints never replace
   server authorization, validation, root assertions, or confirmation.
4. Declare an exact `outputSchema` for every tool that returns
   `structuredContent`, and validate representative success and failure
   results against it. The existing-surface migration currently covers 10
   priority task-level tools; the remaining legacy tools are migration debt,
   not examples to copy for new work.
5. Add or update the capability-factory test under
   `packages/mcp/src/testing/*-tools.test.ts`; add an MCP integration behavior
   test when wiring, preflight, session state, or response behavior changes.
   Write tools still require a root-assertion failure case that verifies zero
   state change.
6. If the tool is read-only and should default to auto approval in Codex,
   update the approval lists in `packages/codex/src/index.ts`; otherwise it
   falls back to the default prompt mode.

## Docs and release

7. Update `docs/capabilities/cap-mcp-route-operations.md` and
   `docs/capabilities/capability-index.md` when the tool adds a capability.
8. Update `plugins/routeledger/skills/routeledger-operator/SKILL.md` when the
   tool changes the recommended agent workflow.
9. If the plugin distribution ships the tool, bump the plugin SemVer in
   `plugins/routeledger/.codex-plugin/plugin.json`, run
   `pnpm build:codex-plugin`, `pnpm smoke:codex-plugin`,
   `pnpm check:codex-plugin-release`, and add a release note under
   `docs/release/release-notes/`.
10. Verify the full and json-only runtimes both expose the expected 49-tool
   surface, including `open_mission_control`,
   `get_mission_control_status`, and `stop_mission_control`.
