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
   15 tools: 4 read-only / 10 write / 1 high-risk). The budget is a
   deliberate gate against silent surface growth.
3. Classify annotations from actual effects, not from apparent product intent.
   `readOnlyHint` is true only when the tool cannot change state;
   `destructiveHint` covers deletion, overwrite, or outcomes that are
   irreversible or difficult to reverse; `openWorldHint` covers publishing or
   affecting public/external systems. Set `idempotentHint` only when repeating
   the same arguments has no additional effect. These hints never replace
   server authorization, validation, root assertions, or confirmation.
4. Declare an `outputSchema` for every tool that returns `structuredContent`
   and validate representative success and failure results against it. The 11
   public tools share a validated response envelope and validate each
   `operation` branch against its exact data schema. Internal capability
   registrations are not public tools and are not examples to copy for new
   work.
5. Add or update the capability-factory test under
   `packages/mcp/src/testing/*-tools.test.ts`; add an MCP integration behavior
   test when wiring, preflight, session state, or response behavior changes.
   Write tools still require a root-assertion failure case that verifies zero
   state change.
   Assign the operation an R0-R3 response-footprint class, add one representative
   compact budget assertion, and verify compact is not larger than standard.
   Preserve exact blockers, user decisions, executable inputs, and L3 identifiers;
   avoid summary/delta fields that only repeat a small read response.
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
10. Verify the source and bundled json-only runtimes both expose the expected
    15-tool surface, including `inspect_runtime`, `inspect_route_progress`,
    `execute_route_change`, and `manage_mission_control`.
