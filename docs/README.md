# RouteLedger documentation

This directory contains the durable documentation for behavior implemented in
this repository. It is not a task tracker, test-run notebook, release-candidate
workspace, or replacement for a bound project's canonical `.routeledger/`
documents.

## Directory map

| Directory | Purpose | Accepted content |
| --- | --- | --- |
| `architecture/` | Long-lived architecture contracts and accepted decisions that still constrain implementation. | Security boundaries, compatibility decisions, and unresolved design constraints. |
| `capabilities/` | Current externally observable product behavior, mapped to source and tests. | One canonical page per capability plus the capability index. |
| `guides/` | Repeatable procedures for users, hosts, and maintainers. | Installation, integration, operation, and extension instructions. |
| `release/` | Durable release policy and immutable published history. | Release procedure, distribution/tag rules, and final release notes. |
| `specification/` | Governance and evidence for the language-agnostic Core Specification. | Specification charter, evidence matrix, and future normative specification. |

New top-level directories require an update to this table and explicit
maintainer review.

## Entry points

- [Capability index](capabilities/capability-index.md) maps product rules to source and tests.
- [Exact authorization contract](architecture/exact-authorization-contract.md) defines the authorization identity, admission, claim, finalize, and replay boundary.
- [NF1 recovery and storage decision](architecture/nf1-recovery-and-storage-decision.md) records the retained commit-owner recovery gap and storage boundary decision.
- [Agent-host integration](guides/agent-host-integration.md) describes the one-server, one-binding runtime contract.
- [L3 route-transition decision protocol](guides/l3-route-transition-decision-protocol.md) defines the accepted end-to-end L3 transition pipeline.
- [L3 authorization V3 host authority broker](guides/l3-authorization-v3-host-broker.md) defines the local three-mode trust boundary and broker contract.
- [Codex plugin installation](guides/codex-plugin-installation.md) describes Git marketplace installation and the runtime boundary.
- [New MCP tool checklist](guides/new-tool-checklist.md) lists the registry, contract, documentation, and release steps for adding a tool.
- [Core Specification charter](specification/core-specification-charter.md) defines scope, evidence rules, normative language, conformance profiles, and change control.
- [Core-contract evidence matrix](specification/core-contract-evidence-matrix.md) maps contract areas to documentation, schemas, implementation symbols, tests, compatibility records, and known gaps.
- [Plugin release](release/plugin-release.md), [release policy](release/release-policy.md), and [distribution and tag conventions](release/distribution-and-tags.md) define the release workflow. Published history lives in [release notes](release/release-notes/).

## Admission rules

Prefer updating an existing canonical document over adding a new file. A new
document is accepted only when it:

1. has a durable audience and purpose covered by the directory map;
2. identifies its source of truth and does not duplicate another document;
3. states its status and, when not permanent, its removal or replacement trigger;
4. links implementation and executable evidence for behavioral claims;
5. is added to this README or the owning directory's index; and
6. contains no maintainer-machine paths, temporary branch tips, transient test
   counts, generated reports, or bound-project data.

Do not add task handoffs, implementation roadmaps, scratch analysis, one-off
test findings, release-candidate audits, screenshots, or generated output to
`docs/`. Keep them in the issue or change that owns the work, in an explicitly
temporary workspace location, or in the relevant automated test. Git history
is the archive for completed implementation plans and superseded decisions.

## Lifecycle rules

- A topic has one canonical durable document. Merge overlapping material
  instead of creating parallel summaries.
- Completed or superseded execution documents are removed in the same release
  closeout that makes them obsolete.
- Capability changes update the capability page and
  [capability index](capabilities/capability-index.md) in the same change.
- Published release notes are immutable historical records; candidate audits
  are not release notes and do not remain in `docs/`.
- Documentation review checks links, status language, implementation evidence,
  and conflicts with the current release before merge.

Code, tests, generated plugin metadata, immutable tags, and the current Git
state remain the sources of truth for implementation and release verification.
