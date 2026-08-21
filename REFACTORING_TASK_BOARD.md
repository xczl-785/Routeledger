# RouteLedger refactoring task board and handoff

Status: active  
Last updated: 2026-08-21  
Working branch: `refactor/code-health-roadmap`  
Implementation base at handoff: `2a3a381`  
Detailed roadmap: [`CODE_HEALTH_AUDIT_AND_REFACTORING_PLAN.md`](./CODE_HEALTH_AUDIT_AND_REFACTORING_PLAN.md)

## Handoff summary

The refactoring branch is pushed and clean. Gates A and B are closed. Stage 5
has started with the safe extraction of read-only L3 proposal access. Continue
from Stage 5; do not repeat completed Stage 1-4 work.

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
| R5.2 | C | Complete read-only L3 application projection | Next | Move `getL3AuthorizationEvaluationContext` and `recommendBalancedL3AuthorizationPolicy` into the read service. Inject only snapshot reader and clock. | Existing evaluation-context and policy tests pass; service performs no save and does not rebuild live gate/digest. |
| R5.3 | C | Define one L3 proposal security port | Todo | Introduce one port returning the complete normalized description: payload, gate snapshot, and digest. Do not expose separate gate/digest callbacks. | Contract tests prove gate, payload, and digest cannot diverge. |
| R5.4 | C | Extract L3 proposal write lifecycle | Todo | After R5.3, move propose persistence, audit event, persistence self-check, and safe rollback together. | Proposal persistence/digest/rollback suites pass unchanged. |
| R5.5 | C | Extract approval, authorization, rejection, and commit orchestration | Todo | Move in small cohesive slices. Keep exact authorization, coordinator lease/fencing, receipt claim/finalize, and live re-evaluation together. | Full L3 protocol, recovery, replay, and authorization suites stay green. |
| R6 | C | Build MCP middleware pipeline | Todo | Centralize `validate -> bind -> authorize -> execute -> project response -> map error`. | Tool contracts and response-detail behavior remain stable. |
| R7 | C | Introduce document-source port | Todo | Remove direct filesystem reads from Core decisions; implement host adapter. | Core runs with in-memory document source; host integration passes. |
| G-C | C | Combined Gate C audit | Todo | Run once after R5-R7, not after each slice. | Full workspace gates plus one focused architecture audit. |
| R8 | D | Decide WorkItem identity | Todo | Record ADR, then encode the chosen aggregate/identity invariant. | ADR and domain/storage tests agree. |
| R9 | D | Add UI/process tests and coverage guard | Todo | Protect native process and thin runtime paths; use coverage as regression guard only. | Agreed process scenarios and thresholds run in CI. |
| R10 | D | Evolve storage boundary | Todo | Make revisions explicit and split broad read/write capabilities after use cases are narrow. | JSON/SQLite stale-write, migration, and compatibility suites pass. |
| G-D | D | Combined Gate D and release audit | Todo | Run once after R8-R10. | Full workspace and release gates pass. |

## Immediate next work

Start with R5.2. The intended method group is:

- `listL3Proposals` — already moved;
- `getL3Proposal` — already moved;
- `getL3AuthorizationEvaluationContext` — move next;
- `recommendBalancedL3AuthorizationPolicy` — move with its evaluation context.

Keep this service read-only. Its dependencies should remain equivalent to:

```ts
{
  storage: ProjectSnapshotReader;
  clock: ClockPort;
}
```

The next focused TDD case should use a current Version and its legal successor,
then assert:

- `targetRelation === "legal-successor"`;
- gate snapshot and digest are projected from the persisted proposal unchanged;
- `now` comes from the injected clock;
- no aggregate save occurs.

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
