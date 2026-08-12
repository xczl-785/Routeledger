# RouteLedger documentation

This directory documents the behavior that is implemented in this repository.
It is not a release record and does not replace a bound project's canonical
`.routeledger/` documents.

## Entry points

- [L3 decision protocol implementation roadmap](roadmaps/l3-decision-protocol-roadmap.md) is the active traditional-document execution record while RouteLedger MCP access is unavailable. It tracks L3-D1 through L3-D6 states, gates, evidence, residuals, and the exact condition for restoring canonical lifecycle tracking.
- [L3 decision protocol and host-adapter handoff](handoffs/l3-authorization-local-route-handoff.md) is the single portable continuation entry, including the accepted L3-D1 through L3-D6 route, current authorization blocker, cleanup inventory, and exact next action.
- [L3 route-transition decision protocol](guides/l3-route-transition-decision-protocol.md) is the accepted post-0.6.0 product and architecture baseline: permission modes automate decision resolution while the complete L3 transition pipeline still runs.
- [L3 decision protocol implementation assessment](guides/l3-decision-protocol-implementation-assessment.md) records the current-code gap, interface/state-machine/adapter migration plan, and effort estimate before implementation begins.
- [Capability index](capabilities/capability-index.md) maps product rules to source and tests.
- [Agent-host integration](guides/agent-host-integration.md) describes the one-server, one-binding runtime contract.
- [L3 authorization V3 host authority broker](guides/l3-authorization-v3-host-broker.md) defines the local three-mode trust boundary, broker contract, and acceptance gates.
- [Codex plugin installation](guides/codex-plugin-installation.md) describes the published Git marketplace installation and runtime boundary.
- [New MCP tool checklist](guides/new-tool-checklist.md) lists the registry, contract, doc, and release steps for adding a tool.
- [Plugin release](release/plugin-release.md), the [release policy](release/release-policy.md), the published [0.6.0 release note](release/release-notes/0.6.0.md), and the [0.7.1 release note](release/release-notes/0.7.1.md) record the current Git marketplace baseline and candidate; Git plugin publication does not publish `@routeledger/mcp` to npm.
- [Distribution and tag conventions](release/distribution-and-tags.md) defines per-artifact versions and tag namespaces on the single `main` release trunk.

## Documentation boundary

Code, tests, generated plugin metadata, and the current Git state are the
source of truth for implementation and release verification. Guides use
placeholder paths such as `/ABS/PATH/TO/ROUTELEDGER_REPO_ROOT`; they never
identify a maintainer workstation or a managed project.

When RouteLedger MCP access is unavailable, the active roadmap may temporarily
record implementation progress. It must not be treated as an approval artifact
or used to justify direct edits to canonical `.routeledger` data.
