# RouteLedger refactoring task board and handoff

Status: active  
Last updated: 2026-08-21  
Working branch: `refactor/code-health-roadmap`  
Implementation base at handoff: `4e94b0f`
Detailed roadmap: [`CODE_HEALTH_AUDIT_AND_REFACTORING_PLAN.md`](./CODE_HEALTH_AUDIT_AND_REFACTORING_PLAN.md)

## Handoff summary

Gates A and B are closed. Stage 5 is active: proposal reads, the atomic
proposal-security boundary, and the complete proposal write lifecycle are
extracted. Continue from R5.5; do not repeat completed R5.1-R5.4 work.

The current architectural direction is deliberately incremental:

- keep `RouteLedgerService` as a compatibility facade;
- move cohesive use cases behind explicit, narrow interfaces;
- preserve canonical JSON bytes and public response contracts;
- keep L3 gate, normalized payload, digest, exact authorization, fencing, and
  live commit re-evaluation as one security chain;
- run one independent architecture audit per combined group, not per commit.

## Board

| ID | Group | Task | Status | Delivered / next action | Exit evidence |
| --- | :---: | --- | :---: | --- | --- |
| R1 | A | Recover abandoned L3 commit ownership | Done | Closed in `faf7d02`; Gate A recorded in `6c14a0b`. | Crash windows, restart, fencing, migration, and concurrency tests. |
| R2 | B | Centralize canonical JSON descriptors | Done | `4c0ff21`, `fee6031`. | Canonical paths, schema projection, codec and validator compatibility preserved. |
| R3 | B | Enforce package boundaries | Done | `3ecca61`, `eee42d1`, `d5f81d9`. | Ordinary cross-package source inclusion removed; only six bundled-runtime includes remain in the exact baseline. |
| R4 | B | Extract query, Batch, and Version use cases | Done | `1f2c48d` through `4995a7c`. | Facade delegates query, Batch, prepare, and completion paths; aggregate revision and digest behavior preserved. |
| G-B | B | Combined Gate B audit | Done | `fa38a9c`. Blocking: 0; correctness findings: 0. | 83 test files; 757 passed, 1 skipped; typecheck, lint, and package-boundary gate passed. |
| R5.1 | C | Extract L3 proposal reads | Done | `2a3a381` adds `L3ProposalReadService` and delegates list/get. | Proposal ordering and not-found contracts pass; no write path moved. |
| R5.2 | C | Complete read-only L3 application projection | Done | `98c445d` moves authorization evaluation context and balanced-policy projection behind the read service. | Snapshot-reader and clock are the only dependencies; persisted gate/digest projection and no-save behavior are covered. |
| R5.3 | C | Define one L3 proposal security port | Done | `f711d89` adds one atomic `describe` port and keeps post-save canonical verification non-injectable. | Lossy payload and gate persistence are rejected and safely rolled back; self-signing digest injection is not exposed. |
| R5.4 | C | Extract L3 proposal write lifecycle | Done | `4e94b0f` moves proposal creation, audit, canonical persistence self-check, and concurrency-aware rollback into one internal service. | 68 focused and adjacent tests pass; lossy payload/gate and linked-approval rollback guards are explicit. |
| R5.5 | C | Extract approval, authorization, rejection, and commit orchestration | Next | Move in small cohesive slices. Keep exact authorization, coordinator lease/fencing, receipt claim/finalize, and live re-evaluation together. | Full L3 protocol, recovery, replay, and authorization suites stay green. |
| R6 | C | Build MCP middleware pipeline | Todo | Centralize `validate -> bind -> authorize -> execute -> project response -> map error`. | Tool contracts and response-detail behavior remain stable. |
| R7 | C | Introduce document-source port | Todo | Remove direct filesystem reads from Core decisions; implement host adapter. | Core runs with in-memory document source; host integration passes. |
| G-C | C | Combined Gate C audit | Todo | Run once after R5-R7, not after each slice. | Full workspace gates plus one focused architecture audit. |
| R8 | D | Decide WorkItem identity | Todo | Record ADR, then encode the chosen aggregate/identity invariant. | ADR and domain/storage tests agree. |
| R9 | D | Add UI/process tests and coverage guard | Todo | Protect native process and thin runtime paths; use coverage as regression guard only. | Agreed process scenarios and thresholds run in CI. |
| R10 | D | Evolve storage boundary | Todo | Make revisions explicit and split broad read/write capabilities after use cases are narrow. | JSON/SQLite stale-write, migration, and compatibility suites pass. |
| G-D | D | Combined Gate D and release audit | Todo | Run once after R8-R10. | Full workspace and release gates pass. |

## Immediate next work

Start with R5.5 and keep each slice cohesive:

1. Map approval, exact authorization, rejection, and commit responsibilities
   and freeze their facade contracts with delegation tests.
2. Extract approval/rejection only where they do not split exact-authorization
   ownership or receipt state.
3. Move commit orchestration only as one complete chain: exact authorization,
   lease renewal, fencing assertion, receipt claim, live re-evaluation,
   canonical save, receipt finalization, and owner-checked release.

Do not expose injectable security or commit implementations through the public
package root. Preserve replay, crash-window, authorization, and migration
evidence throughout the extraction.

## L3 safety constraints

Do not move `proposeL3Operation` by itself. It currently couples all of the
following behaviors and they must not be duplicated or split across unrelated
callbacks:

- normalized operation payload;
- live gate snapshot;
- canonical operation digest;
- pending proposal and audit-event persistence;
- post-save digest reconstruction and self-consistency check;
- concurrency-aware safe rollback after a persistence mismatch.

Before extracting proposal writes, introduce one security port with an atomic
description result, conceptually:

```ts
interface L3ProposalSecurityPort {
  describe(input: L3DescribeInput): {
    actionType: L3ActionType;
    targetId: string;
    payload: PendingOperationPayload;
    gateSnapshot: GateSnapshot;
    digest: OperationDigest;
  };

  rebuildDigest(input: L3RebuildDigestInput): OperationDigest;
}
```

Commit remains the most sensitive migration. Preserve these invariants as one
chain: exact authorization binding, ownership lease renewal, fencing assertion,
receipt claim, canonical save, receipt finalization, and owner-checked release.

## Verification policy

Use focused checks for each slice:

```powershell
pnpm exec vitest run <affected-test-files>
pnpm exec tsc -p packages/core/tsconfig.json --pretty false
pnpm exec eslint <affected-files>
pnpm check:package-boundaries
git diff --check
```

Run the full repository only at a combined gate or before release:

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm check:package-boundaries
```

The last full Gate B run passed 83 test files with 757 tests passed and 1
skipped.

## New-machine startup

```powershell
git fetch origin
git switch refactor/code-health-roadmap
git pull --ff-only origin refactor/code-health-roadmap
pnpm install --frozen-lockfile
git status --short --branch
pnpm exec vitest run packages/core/src/testing/service-l3-proposal-read-delegation.test.ts
pnpm exec tsc -p packages/core/tsconfig.json --pretty false
pnpm check:package-boundaries
```

Expected initial state:

- branch tracks `origin/refactor/code-health-roadmap`;
- worktree is clean;
- the focused L3 proposal read test passes;
- do not touch the reserved `codex-marketplace` branch.

## Commit and review discipline

- Begin each behavior slice with a focused RED test where practical.
- Keep commits small and independently green; push after each coherent slice.
- Do not open an architecture audit for each commit. The next scheduled audit
  is Gate C after Stages 5-7.
- Do not combine behavior changes with broad formatting or generated runtime
  updates.
- Do not merge, rebase, tag, or release this branch until the user explicitly
  requests the release workflow.

## Local-only state not transferred by Git

This machine has `stash@{0}` named:

```text
On fix/agent-first-feedback: preserve local feedback deletion before architecture refactor
```

The stash currently represents only a local deletion of
`TEMP_AGENT_TEST_FEEDBACK_ANALYSIS.md`. It is not part of the refactoring,
is not required on the next machine, and will not be transferred by `git push`.
Do not assume any stash exists after cloning or switching machines.

The tracked `RouteLedger-Agent-First-体验反馈.md` remains outside the current
refactoring scope, as previously requested.

## Known non-blocking observations

During the package-boundary work, two standalone Mission Control smoke commands
showed assertion drift before reaching the boundary being changed:

- source smoke returned `ACTION_NOT_IMPLEMENTED` from `init_project`;
- packaged JSON-only smoke received advisory Mission Control guidance where the
  smoke expected executable guidance.

The full repository test suite and bundled artifact import checks passed. Treat
these smoke mismatches as separate test-maintenance work; do not silently change
product behavior while continuing Stage 5.
