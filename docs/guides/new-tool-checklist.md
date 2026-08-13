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
   48 tools: 22 read-only / 21 write / 5 high-risk). The budget is a
   deliberate gate against silent surface growth.
3. Add or update the capability-factory test under
   `packages/mcp/src/testing/*-tools.test.ts`; add an MCP integration behavior
   test when wiring, preflight, session state, or response behavior changes.
   Write tools still require a root-assertion failure case that verifies zero
   state change.
4. If the tool is read-only and should default to auto approval in Codex,
   update the approval lists in `packages/codex/src/index.ts`; otherwise it
   falls back to the default prompt mode.

## Docs and release

5. Update `docs/capabilities/cap-mcp-route-operations.md` and
   `docs/capabilities/capability-index.md` when the tool adds a capability.
6. Update `plugins/routeledger/skills/routeledger-operator/SKILL.md` when the
   tool changes the recommended agent workflow.
7. If the plugin distribution ships the tool, bump the plugin SemVer in
   `plugins/routeledger/.codex-plugin/plugin.json`, run
   `pnpm build:codex-plugin`, `pnpm smoke:codex-plugin`,
   `pnpm check:codex-plugin-release`, and add a release note under
   `docs/release/release-notes/`.
8. Verify the json-only runtime exposes the expected tool count (full 48,
   json-only 46, difference is exactly `open_mission_control` and
   `get_mission_control_status`).
