# NF1 non-functional refactor and core-contract audit roadmap

Status: planning only. No production refactor is authorized by this document.

The captured starting point is recorded in the
[NF1 refactor baseline](../architecture/nf1-baseline.md).

## Outcome

Reduce concentration and accidental coupling without changing RouteLedger's
observable behavior, persisted semantics, tool contracts, or release identity.
The work must leave each accepted change independently reviewable and
reversible.

## Decisions already supported by the audit

- Keep `RouteLedgerService` as the public application facade while extracting
  cohesive collaborators behind it. Callers must not migrate in the same wave.
- Split MCP tool definition, registration, and dispatch by capability while
  preserving the existing `RouteLedgerMcpRegistry` surface and tool metadata.
- Make canonical model and lifecycle contracts explicit before moving their
  implementations. Characterization tests precede extraction.
- Treat stale persisted commit ownership and stale local authority locks as
  correctness/recovery work, not as a mechanical refactor. They require a
  separate issue, threat model, tests, and release decision.
- The [NF1 recovery and storage-boundary decision](../architecture/nf1-recovery-and-storage-decision.md)
  confirms that the authority state-file lease model stays in place, persisted
  commit-owner recovery moves to a future functional Version, and the NF1
  storage-boundary extraction is deferred.
- Fix package-local test entry points separately. The current CLI and MCP
  package scripts name test files that do not exist, even though root-level
  test discovery remains available.

## Scope boundary

In scope:

- contract inventory and traceability;
- characterization tests for current behavior;
- internal module extraction with stable public facades;
- dependency-direction and ownership cleanup;
- package test-runner accuracy;
- documentation of decisions, invariants, and acceptance evidence.

Out of scope unless separately approved:

- new tools, commands, UI behavior, or workflow states;
- schema or wire-format changes;
- changes to L3 authorization policy or trust boundaries;
- changes to canonical JSON ordering, binding, or route lifecycle semantics;
- recovery-policy changes for persisted ownership or locks;
- a plugin SemVer bump caused only by generated distribution churn.

## Core Specification relationship

A language-agnostic RouteLedger Core Specification is worth doing. The audit
confirmed that the contract already exists but is distributed across capability
documents, guides, release material, schemas, tests, and implementation. The
specification should be a contract-governance deliverable and an input to the
refactor, not an incidental by-product hidden inside code-movement commits.

The large workspace-level reference `SPEC.md` is intentionally not consumed
during this planning pass. Review it only after the RouteLedger specification
charter and evidence inventory below are accepted. At that point, compare its
structure and normative-language conventions; do not import product semantics
that are unsupported by RouteLedger code, tests, or published contracts.

The first RouteLedger specification draft should freeze only established
contracts:

1. Project, Version, Todo, Deferred, Constraint, and TransitionEvent meanings.
2. Canonical JSON authority, schema/versioning, deterministic encoding, and
   SQLite's read-model boundary.
3. Physical root binding and one-server/one-binding assertions.
4. Route lifecycle, current pointer, preparation, start, close, reopen, and
   advance invariants.
5. L3 proposal, decision, approval artifact, exact authorization, claim,
   commit, replay, and audit protocol.

Every normative statement must link to at least one implementation symbol and
one executable test or be marked as an unresolved contract gap.

## Work sequence and gates

| Stage | Work | Exit gate |
| --- | --- | --- |
| NF1-0 Baseline | Record repository, release tag, generated distribution, test inventory, public exports, MCP tool list, canonical fixtures, and known-red checks. | Reproducible baseline report; clean tree; every red check has an owned follow-up. |
| NF1-1 Test harness | Correct package-local test entry points, cap filesystem-heavy test concurrency, and verify the focused MCP version workflow and child-process cleanup. | Package and focused commands execute real tests and exit cleanly; any remaining root failure has one independently owned cause. |
| NF1-2 Recovery decision | Complete. The Windows authority-lock acquisition and release `EPERM` races were fixed independently; persisted commit-owner recovery is specified as separate functional work; the NF1 storage-boundary extraction is deferred. | Root tests are green; no recovery-policy change is hidden inside mechanical extraction. |
| NF1-3 Contract inventory | Complete. The charter fixes scope, evidence rules, normative language, conformance, and change control; the initial matrix maps five specification areas to docs, schemas, source symbols, tests, compatibility, and explicit gaps. The reference SPEC influenced structure only. | No normative statement without evidence or an explicit gap marker. |
| NF1-4 Characterization | Complete. The complete MCP tool-contract/profile manifest and application error compatibility manifest now supplement the existing canonical, binding, and L3 suites. Later extraction slices add only seam-local gaps. | Both manifests failed under a deliberate one-value perturbation, passed after restoration, and the root suite is green. |
| NF1-5 MCP registry seams | Move tool definitions and handlers into capability modules behind the existing registry. | Tool names, schemas, annotations, visibility, instructions, and responses are byte/semantic equivalent. |
| NF1-6 Application seams | Extract one cohesive policy/query/transition collaborator at a time behind `RouteLedgerService`; keep exports and call signatures stable. | Per-extraction focused tests plus full root suite; no contract or fixture diff. |
| NF1-7 Storage boundary | Deferred by the NF1 recovery decision. Reconsider only after the separate commit-owner recovery design establishes a concrete need and compatibility boundary. | No storage implementation change in NF1; canonical bytes and current stale-snapshot behavior remain unchanged. |
| NF1-8 Closeout | Remove temporary adapters, update traceability, run release-distribution checks, and decide whether generated bytes require SemVer. | Reviewable evidence bundle and no undocumented compatibility change. |

Only one extraction stage should be active at a time. Do not combine application,
MCP registry, storage, and recovery changes in one commit or pull request.

## Separate prerequisite/corrective tracks

These findings are actionable but must remain distinct from the non-functional
refactor:

1. Package test scripts: point `packages/cli` and `packages/mcp` at real test
   entry points or documented package globs, then prove the package commands run.
2. Persisted commit ownership: define process-death recovery for
   `commitOwners`, including identity, liveness/lease, timeout, replay, and
   fail-closed behavior.
3. Local authority lock: verify and, if necessary, add stale-owner recovery for
   the state-file lock without weakening lock identity, heartbeat, revision, or
   private-file checks.
4. Windows host smoke: replace shell-sensitive invocation with a portable
   launcher and cover it on Windows CI.

Tracks 2 and 3 are security-sensitive functional fixes. Complete them before a
storage-boundary refactor, or explicitly defer that refactor until their
semantics are settled.

## Change acceptance checklist

For every refactor slice:

- state the invariant and exact symbols being moved;
- capture affected callers with CodeGraph before editing;
- add or identify focused characterization tests;
- keep public exports and MCP schemas stable;
- compare canonical fixtures and generated plugin bytes;
- run focused tests, root tests, typecheck, lint, and applicable release checks;
- record any intentional byte change and its SemVer consequence;
- keep the commit limited to one extraction seam.

## First review packet

Before production refactoring begins, review and approve these artifacts:

- the core-specification charter and evidence matrix template;
- the package-test-script correction as an isolated maintenance change;
- the recovery findings as separate corrective issues;
- the first proposed `RouteLedgerService` extraction seam and its
  characterization-test list;
- the decision on whether NF1-5 storage work remains in this Version.
