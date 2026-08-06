# Capability index

| Capability | Current rule | Primary evidence |
| --- | --- | --- |
| [Route work semantics](cap-route-work-semantics.md) | Todo is current work, Deferred has a finite review target, and Constraint is a rule. | `packages/core/src/domain/`, `packages/core/src/services/`, `packages/core/src/testing/` |
| [Canonical JSON contract](cap-canonical-json-contract.md) | Canonical documents have a fixed layout, validation, recovery, and merge-check contract. | `packages/json/src/`, `packages/json/src/testing/` |
| [JSON-first runtime storage](cap-json-first-runtime-storage.md) | MCP reads canonical JSON first and writes it before any optional read-model sync. | `packages/mcp/src/json-first-storage.ts`, `packages/mcp/src/testing/` |
| [SQLite read-model boundary](cap-sqlite-read-model-truth-source-boundary.md) | SQLite is a compatibility/read-model implementation, not the JSON-first runtime's authority. | `packages/sqlite/src/`, `packages/mcp/src/json-first-storage.ts` |
| [MCP route operations](cap-mcp-route-operations.md) | Binding preflight, root assertions, gates, and approval artifacts constrain tool operations. | `packages/mcp/src/`, `packages/core/src/` |
| [MCP runtime packaging](cap-mcp-runtime-packaging.md) | Full and JSON-only artifacts share a build; the JSON-only artifact excludes native SQLite and UI bundles. | `packages/mcp/scripts/`, `packages/mcp/src/` |
| [Codex plugin package](cap-codex-plugin-package.md) | The repository root contains the marketplace and one generated JSON-only plugin distribution. | `scripts/`, `.agents/plugins/marketplace.json`, `plugins/routeledger/` |

Paths are repository-root relative. A capability records current implementation
rules only; it does not certify a remote publication or an external service.
