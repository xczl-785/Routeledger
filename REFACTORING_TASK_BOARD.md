# RouteLedger refactoring task board and handoff

Status: active  
Last updated: 2026-08-21  
Working branch: `refactor/code-health-roadmap`  
Implementation base at handoff: `56d6cc1`
Detailed roadmap: [`CODE_HEALTH_AUDIT_AND_REFACTORING_PLAN.md`](./CODE_HEALTH_AUDIT_AND_REFACTORING_PLAN.md)

## Handoff summary

Gates A, B, and C are closed. Stages 8-10 are implemented: WorkItem has an
explicit lineage identity, UI process and coverage boundaries are executable CI
gates, and aggregate revisions are public optimistic-concurrency tokens across
JSON and SQLite. Gate D audit is next; do not repeat completed R5-R10 work.

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
| R5.5 | C | Extract approval, authorization, rejection, and commit orchestration | Done | `bbf680b` extracts legacy approval/rejection; `989ac36` extracts exact authorization and the complete commit/fencing/receipt/live-re-evaluation chain. | Core 39 files / 334 tests pass; independent audit found no security behavior regression and its code-health finding was corrected. |
| R6 | C | Build MCP middleware pipeline | Done | `0dea7f4` introduces the pipeline; `1ad1726` moves known-tool schema validation ahead of bind and authorization. | 2025/2026 projection, broker, authorization, response-detail, and error behavior pass; malformed L3 input short-circuits before broker bind. |
| R7 | C | Introduce document-source port | Done | `8fe9538` removes Core filesystem reads and injects a containment-safe JSON host adapter. | Core uses an in-memory source; JSON covers UTF-8, ENOENT, and symlink escape; CLI/MCP integration passes. |
| G-C | C | Combined Gate C audit | Done | Independent audit found two blockers; both closed in `1ad1726`. No other medium/high-risk findings. | 90 test files; 773 passed, 1 skipped; typecheck, lint, package-boundary, and diff gates pass. |
| R8 | D | Decide WorkItem identity | Done | `72c1a9c` records WorkItem as the Project aggregate's stable supporting lineage identity and enforces one active child. | ADR, Core, JSON, and SQLite tests agree; canonical schema remains unchanged. |
| R9 | D | Add UI/process tests and coverage guard | Done | `5c95771` adds a real headless Hub lifecycle test and enforceable global/UI-server coverage floors in CI. | 91 files / 779 passed / 1 skipped at delivery; authenticated startup/shutdown and registry cleanup run without a browser. |
| R10 | D | Evolve storage boundary | Done | `56d6cc1` replaces hidden Symbol metadata with explicit revisions, narrow reader/writer ports, and SQLite migration `0010`. | JSON hash and SQLite token domains, two-instance stale writes, migration prefixes, canonical bytes, and read-model sync pass. |
| G-D | D | Combined Gate D and release audit | Audit | Run one independent audit across R8-R10 and close any blockers before push. | Full workspace: 92 files / 785 passed / 1 skipped; coverage, typecheck, lint, package boundaries, and release-sensitive scripts pass. |

## Immediate next work

Run the single combined Gate D architecture and release audit over R8-R10.
Focus on lineage compatibility, real process cleanup, effective coverage
thresholds, revision-token isolation, atomic stale-write rejection, migration
prefixes, and canonical-byte stability. Fix any blocker once, rerun the full
workspace gates, then record the final implementation base and handoff state.

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
}
```

Post-save verification must remain an internal, non-injectable canonical digest
rebuild over material that does not contain the persisted digest itself.

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

The current pre-audit Gate D run passed 92 test files with 785 tests passed and 1
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
  is Gate D after R8-R10.
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
