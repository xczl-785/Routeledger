# RouteLedger documentation

This directory documents the behavior that is implemented in this repository.
It is not a release record and does not replace a bound project's canonical
`.routeledger/` documents.

## Entry points

- [L3 local authorization route handoff](handoffs/l3-authorization-local-route-handoff.md) records the V1/V2/V3 continuation route after 0.6.0, including the incomplete Codex chooser and deferred MCP protocol work.
- [L3 route-transition decision protocol](guides/l3-route-transition-decision-protocol.md) is the accepted post-0.6.0 product and architecture baseline: permission modes automate decision resolution while the complete L3 transition pipeline still runs.
- [Capability index](capabilities/capability-index.md) maps product rules to source and tests.
- [Agent-host integration](guides/agent-host-integration.md) describes the one-server, one-binding runtime contract.
- [L3 authorization V3 host authority broker](guides/l3-authorization-v3-host-broker.md) defines the local three-mode trust boundary, broker contract, and acceptance gates.
- [Codex plugin installation](guides/codex-plugin-installation.md) describes the published Git marketplace installation and runtime boundary.
- [New MCP tool checklist](guides/new-tool-checklist.md) lists the registry, contract, doc, and release steps for adding a tool.
- [Plugin release](release/plugin-release.md), the [release policy](release/release-policy.md), and the [0.4.4 release note](release/release-notes/0.4.4.md) record the current Git marketplace release state; Git plugin publication does not publish `@routeledger/mcp` to npm.
- [Distribution and tag conventions](release/distribution-and-tags.md) defines per-artifact versions and tag namespaces on the single `main` release trunk.

## Documentation boundary

Code, tests, generated plugin metadata, and the current Git state are the
source of truth for implementation and release verification. Guides use
placeholder paths such as `/ABS/PATH/TO/ROUTELEDGER_REPO_ROOT`; they never
identify a maintainer workstation or a managed project.
