# L3 decision protocol implementation roadmap

Status: active execution record

Updated: 2026-08-11

Source branch: `docs/v3-codex-authorization-handoff`

Starting source commit: `6167bf6062f89c0c3915d641b036359b0b2ec94e`

## 1. Purpose and temporary governance boundary

This document is the temporary execution source of truth for the accepted L3-D1 through L3-D6
route while the current Codex task cannot access the installed RouteLedger MCP tools.

RouteLedger remains the intended lifecycle system, but it is not an implementation admission gate
for this run. The following boundary is mandatory:

- do not edit canonical `.routeledger` JSON by hand;
- do not treat chat approval, a CLI response, or this roadmap as an L3 approval artifact;
- record implementation progress, gates, evidence, residuals, and decisions here;
- restore RouteLedger only after a live `get_runtime_context` proves the intended workspace,
  RouteLedger root, project, locale, runtime identity, and JSON-only storage mode;
- after restoration, reconcile this document into canonical Versions and Todos through MCP tools;
  do not manufacture or rewrite historical RouteLedger events.

The canonical data repository was restored to `main@fc78676` on 2026-08-11. It still records
V2.16 as current and preserves rejected proposal `739f37c8-8e2e-427c-a4b4-98aa775764e9`.
No L3-D1 through L3-D6 Version has been created there.

External dirty baseline, preserved and excluded from this delivery:

- `/Users/zhengpanpan/Program/Routeledger/Routeledger-Internal/RouteLedger/packages/mcp/dist-plugin-runtime/`
  is untracked on the restored Internal `main` checkout; this run did not create, clean, or adopt it.

## 2. Complete target

RouteLedger must expose one host-neutral route-transition decision protocol to Codex and generic
MCP hosts. Permission modes change only how a decision is resolved and how often a user is
interrupted. Every successful mutation still performs:

```text
exact proposal
  -> decision resolution
  -> exact decision artifact
  -> commit-time live validation
  -> atomic commit
  -> receipt and audit
```

The complete result includes interactive, delegated, and finite preauthorized behavior; one-call
execution; independent Codex and generic MCP adapters; compatibility and recovery coverage; and a
release candidate. It does not include remote/multi-user/OAuth authority, Mission Control as a
canonical writer, automatic publication, or removal of legacy data readers without migration
proof.

## 3. Source-truth order

1. Current source, tests, generated contracts, and Git state.
2. Accepted product definition in `docs/guides/l3-route-transition-decision-protocol.md`.
3. Current-code assessment in `docs/guides/l3-decision-protocol-implementation-assessment.md`.
4. Task handoff in `docs/handoffs/l3-authorization-local-route-handoff.md`.
5. This roadmap for execution status, gates, evidence, and residual ownership.
6. RouteLedger live state after MCP access is restored and reconciled.

Historical completion claims and rejected proposals are evidence, not current implementation
state.

## 4. Single-mainline operating model

- One integration branch and one current implementation producer own shared L3 contracts.
- Versions advance in order; the next Version remains `wait` until the current Version passes its
  Result Gate and closes in this document.
- Read-only reconnaissance and independent audit may occur after a stable checkpoint, but no
  second producer may concurrently modify the decision, grant, receipt, or commit hotspots.
- An Integrity Gate may return `NO-CLOSE`; findings stay in the current Version until fixed,
  deferred with a durable owner, or escalated for a route decision.
- Three non-converging reworks with the same cause stop implementation for user adjudication.

## 5. Route status

| Version | Outcome | State | Entry gate | Result gate | Deferred / constraints |
| --- | --- | --- | --- | --- | --- |
| L3-D1 | Host-neutral decision contract and compatible logical phase projection | `complete` | Product definition accepted; source baseline clean | Public contract tests, legal/illegal transition matrix, existing L3 regression green, no canonical schema migration | No Codex fields in core; no orchestration or adapter implementation |
| L3-D2 | Existing replay, preauthorized, delegated, and interactive paths behind one adapter boundary | `ready_for_checkpoint` | D1 contract frozen and closed | Four paths and negative matrices remain behavior-equivalent | Keep low-level tools and finite-capability checks |
| L3-D3 | One external call completes automatic decisions or returns recoverable input-required state | `wait` | D2 compatibility boundary closed | No double-consume/commit across retry, duplicate, disconnect, and recovery | Host mode discovery remains D4/D5 |
| L3-D4 | Codex adapter proves three user-facing behaviors in a real Desktop session | `wait` | D3 orchestrator closed; fresh host available | Equivalent canonical mutations/audit across modes; explicit fallback when mode is unavailable | Do not infer conversation mode or place Codex fields in core |
| L3-D5 | Generic MCP 2025/2026 adapter and non-Codex conformance | `wait` | D3 stable API and D4 host/core boundary | Equivalent proposal outcomes; tamper/disconnect/timeout/retry/crash matrix | Local single-user only; no Codex assumptions |
| L3-D6 | Compatibility cleanup, recovery matrix, full regression, and release candidate | `wait` | D4 and D5 accepted | Full tests/typecheck/lint/package/plugin/host smokes and independent RC audit | No merge, tag, publish, or release without separate authorization |

## 6. L3-D1 contract gate

### Observable result

Core and host adapters can use one public request/result vocabulary, and every existing L3 record
can be projected into an honest logical phase without changing stored JSON.

### Stable contract to produce

- `ExactProposalDecisionRequest` binds the exact proposal identity, operation digest, project,
  target, action, and current decision context required by an adapter.
- `DecisionResolution` is exactly one of `resolved`, `input_required`, or `denied`.
- `L3DecisionAdapter` resolves a request but cannot commit canonical mutations.
- Logical phases are `proposed`, `decision_required`, `decision_resolved`, `committing`,
  `committed`, `rejected`, `stale`, and `failed`.
- Projection consumes existing `PendingOperation`, `ApprovalArtifact`, and authorization receipt
  evidence. It does not add a persisted phase field in D1.

### Positive oracles

- pending proposal without a decision projects to `proposed` or `decision_required` from explicit
  evidence rather than guesswork;
- approved exact artifact projects to `decision_resolved`;
- a valid commit claim projects to `committing`;
- committed and rejected operations project deterministically;
- stale and failed execution outcomes can be represented without rewriting the proposal.

### Negative oracles

- `proposed -> committing` without a resolved exact decision is rejected;
- adapter output cannot directly commit or widen the proposal scope;
- mismatched proposal/artifact/receipt identities fail closed;
- unknown, contradictory, or incomplete evidence does not project a more advanced phase;
- public contract and JSON schema tests prove no canonical storage migration.

### Implementation slices

1. Add failing public-contract tests for request/result/adapter shapes.
2. Add failing projection and transition-guard tests, including contradictory evidence.
3. Implement the smallest host-neutral application module.
4. Integrate projection with existing types without changing storage codecs.
5. Run focused core tests, full existing L3 tests, typecheck, lint, and schema/diff checks.

## 7. D1 evidence log

| Checkpoint | Status | Evidence | Impact |
| --- | --- | --- | --- |
| Repository and handoff orientation | `passed` | Clean source branch at `6167bf6`; accepted protocol and assessment reread | D1 boundary confirmed |
| Canonical RouteLedger admission | `deferred_infrastructure` | Plugin 0.6.0 installed/enabled, but current task exposes no RouteLedger MCP tools | Document roadmap temporarily owns execution tracking |
| D1 Contract Gate | `passed` | Public request/result/adapter contract, exact-resolution validator, phase projection, and transition guard implemented in `packages/core/src/application/l3-decision.ts` | Contract frozen for D1 |
| D1 Result Gate | `passed` | Implementation commit `163daca`; 13 focused decision tests; 51 repository test files / 578 tests; 6 JSONL client tests; full typecheck and lint; `git diff --check`; no canonical schema or codec changes | D1 closed in this roadmap; D2 remains `wait` |
| D1 Integrity Gate | `deferred_to_D2` | D1 is an additive, unintegrated core contract; independent audit has more information value after D2 routes existing authorization paths through this seam | D2 must trigger Integrity review before its close |

## 8. L3-D2 contract and evidence

### Observable result

`approve_l3_operation` delegates decision-source selection to one compatibility adapter. Replay,
preauthorized, delegated, and interactive paths all produce a D1 exact resolution before the
existing service consumes the grant and creates the approval artifact.

### Frozen boundary

- the adapter may find, request, validate, and issue an exact authorization grant;
- every resolved result must pass the D1 exact-request validator;
- only the existing `authorizeL3Operation` service creates canonical approval artifacts;
- the adapter cannot commit route mutations;
- existing low-level tools, error codes, interaction schema, finite budgets, trusted provenance,
  and external call counts remain unchanged;
- one-call proposal-to-commit orchestration remains D3.

### Evidence log

| Checkpoint | Status | Evidence | Impact |
| --- | --- | --- | --- |
| D2 Contract Gate | `passed` | `ExistingL3DecisionAdapter` implements the D1 interface; handler owns the final service call | Shared adapter seam is frozen |
| Existing path regression | `passed` | Five direct seam tests plus unchanged MCP elicitation, local authorization, broker, profile, write-guard, and replay suites | Four source paths and negative behavior remain equivalent |
| D2 Result Gate | `passed` | 52 repository test files / 583 tests; 6 JSONL client tests; full typecheck and lint; `git diff --check` | D2 is ready for a Git checkpoint; D3 remains `wait` |
| D2 Integrity Gate | `passed` | Side-by-side old/new path audit plus pre-existing authorization and elicitation tests whose oracles were not rewritten for this refactor | No blocking finding; D3 remains separately gated |

## 9. Deferred and decision log

| ID | Item | Reason | Review trigger | Candidate disposition |
| --- | --- | --- | --- | --- |
| L3-DEF-001 | Restore RouteLedger MCP lifecycle tracking | Current task tool snapshot lacks installed RouteLedger tools | A fresh or reloaded host exposes `get_runtime_context` | Reconcile roadmap state through MCP; retain truthful historical events |
| L3-DEF-002 | Decide whether intermediate logical phases should be persisted | D1 intentionally uses compatibility projection | Projection is stable and D3 recovery requirements are measured | Activate a later migration only with schema/rollback proof, otherwise retain projection |
| L3-DEF-003 | Determine Codex effective conversation-mode runtime field | Current support remains unknown | D4 fresh-host capability probe | Dynamic mapping if supported; explicit plugin fallback otherwise |

## 10. Update discipline

At every stable checkpoint, update this file with:

- current Version state and exact Git commit;
- Contract, Result, and Integrity Gate result;
- tests and real-host evidence actually run;
- rework cause and upstream evidence invalidated;
- Deferred activation, re-deferral, or resolution;
- whether the next Version remains `wait`.

Do not mark a Version closed merely because code exists or tests pass. Closure requires its stated
observable result, negative matrix, clean Git scope, evidence reconciliation, and explicit status
update here.
