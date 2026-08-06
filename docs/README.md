# RouteLedger documentation

This directory documents the behavior that is implemented in this repository.
It is not a release record and does not replace a bound project's canonical
`.routeledger/` documents.

## Entry points

- [Capability index](capabilities/capability-index.md) maps product rules to source and tests.
- [Agent-host integration](guides/agent-host-integration.md) describes the one-server, one-binding runtime contract.
- [Codex plugin installation](guides/codex-plugin-installation.md) describes the published Git marketplace installation and runtime boundary.
- [Plugin release](guides/plugin-release.md) and the [release policy](release-policy.md) record the published 0.3.3 release baseline and its verification evidence; Git plugin publication does not publish `@routeledger/mcp` to npm.
- [Undo retirement classification](undo-retirement-data-migration-classification.md) records the current compatibility boundary.

## Documentation boundary

Code, tests, generated plugin metadata, and the current Git state are the
source of truth for implementation and release verification. Guides use
placeholder paths such as `/ABS/PATH/TO/ROUTELEDGER_REPO_ROOT`; they never
identify a maintainer workstation or a managed project.
