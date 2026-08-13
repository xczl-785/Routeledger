# NF1 refactor baseline

Captured: 2026-08-13

This document freezes the starting evidence for the NF1 non-functional
refactor. It records observed state; it does not claim that the baseline is
fully green or authorize a production refactor.

## Repository and release identity

| Item | Baseline |
| --- | --- |
| Working branch | `feature` |
| NF1 starting source commit | `ce18066a218960e49786eeaae847a1e5787f1b48` |
| Published `main` commit | `dd0d95b7b015a8bbfba91c040f811917d963f968` |
| Published tag | `routeledger-plugin-v0.8.0`, annotated and fixed to `dd0d95b` |
| Plugin version | `0.8.0` |
| Runtime payload digest | `18a1e54f42452bd79d161254d34c7c3a3a02e6cca36666d01186edf22b3532d0` |
| Runtime digest | `662e83f02383f1e19a49d5171041e17c630b48f0ec50b1a70faa5b9ad3b3b0bd` |
| Plugin distribution digest | `60bcb15aee8796d07a0dde21981a27eb0ac1c5660600eb79c7ef3cebb871ea23` |
| CodeGraph | 275 files, 5,090 nodes, 22,245 edges; index current |

The distribution digests come from `plugins/routeledger/release.json`. The
tag-only `--require-tag-ref` check is expected to fail on later `feature`
commits because the immutable 0.8.0 tag correctly remains on its published
`main` commit. Run that check from the tag checkout, not as an ordinary feature
branch gate.

## Workspace and public entry points

There are seven workspace packages. Their current entry points are source
`src/index.ts` files except for the UI application:

| Package | Entry point | Baseline note |
| --- | --- | --- |
| `@routeledger/core` | `packages/core/src/index.ts` | Domain, ports, application contracts, facade, and domain services are re-exported from one barrel. |
| `@routeledger/json` | `packages/json/src/index.ts` | Canonical codec, validation, merge/review, and schema API. |
| `@routeledger/sqlite` | `packages/sqlite/src/index.ts` | Database, migrations, and read-model adapter. |
| `@routeledger/mcp` | `packages/mcp/src/index.ts` | Registry facade, tool contracts, authorization adapters, and protocol constants. Package version remains `0.0.0-package-prep` and unpublished. |
| `@routeledger/cli` | `packages/cli/src/index.ts` | `runCli` and its options. |
| `@routeledger/codex` | `packages/codex/src/index.ts` | Codex configuration and permission-mode contracts. |
| `@routeledger/ui` | Vite application | No package library export. |

Public export declarations must remain stable during internal extraction unless
a separately reviewed compatibility change says otherwise.

## MCP tool surface

`createRouteLedgerMcpRegistry` in `packages/mcp/src/index.ts` is the authoritative
registry constructor. The baseline contains 48 `defineTool` registrations:

```text
get_runtime_context, get_l3_authorization_status,
recommend_l3_authorization_profile, discover_routeledger_roots,
plan_routeledger_binding, activate_routeledger_binding,
render_host_binding_config, write_host_binding_config,
open_mission_control, get_mission_control_status, init_project,
set_project_content_locale, get_current_context, next_action,
check_doc_drift, summarize_version_closeout, plan_version_closeout,
list_versions_window, list_versions, check_start_gate, check_close_gate,
get_version_structure, get_version_transition_guide,
recommend_l3_authorization_policy, list_l3_proposals, get_l3_proposal,
batch_create_versions, transition_version, advance_to_version,
close_version, shutdown_version, create_todo, close_todo, defer_work,
review_deferred, record_constraint, retire_constraint, prepare_version,
mark_version_complete, create_version, insert_version,
create_child_version, reorder_versions, propose_l3_operation,
execute_l3_operation, approve_l3_operation, commit_l3_operation,
reject_l3_operation
```

Names alone are insufficient for equivalence. NF1 must also preserve input
schemas, annotations, RouteLedger risk metadata, visibility, instructions, and
tool-level error/response semantics.

## Source and test inventory

- 163 TypeScript/TSX/JavaScript source files under `packages/`, excluding
  generated distribution directories.
- 60 test files: core 25, MCP 23, JSON 4, CLI 3, Codex 2, UI 2, SQLite 1.
- Canonical JSON fixtures live under
  `packages/json/src/testing/fixtures/canonical/.routeledger/`.
- Exact-authorization migration fixtures live under
  `packages/core/src/testing/fixtures/exact-authorization-v1/`.
- Generated plugin identity and checksums live in
  `plugins/routeledger/release.json`.

Current concentration hotspots, measured as physical source lines during this
capture:

| File | Lines |
| --- | ---: |
| `packages/core/src/application/routeledger-service.ts` | 5,385 |
| `packages/mcp/src/index.ts` | 4,102 |
| `packages/mcp/src/local-l3-authorization.ts` | 1,176 |
| `packages/mcp/src/json-first-storage.ts` | 899 |

Line count is a navigation signal, not an extraction target or acceptance
metric.

## Baseline checks

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm check:codex-plugin-release` | Pass |
| `pnpm check:codex-plugin-release --require-tag-ref` on `feature` | Expected failure: immutable tag points to published `dd0d95b`, not feature HEAD |
| `pnpm test` | Red: one 15-second timeout in the first `mcp-versions.test.ts` registry-restart/atomic-advance test |
| Focused `mcp-versions.test.ts` run | Red: does not exit within 60 seconds |

The root run executes subprocess-based tests concurrently with this workflow.
When the outer test runner is terminated, those sibling MCP/runtime/CodeGraph
children may remain alive and amplify later runs; the first version-workflow
test itself does not spawn them. The processes created during this capture were
identified by creation time and exact command line and then terminated. Process
ownership and cleanup must still be verified before characterization or
refactor work begins.

## Follow-up triage

Subsequent focused runs separated two independent causes:

- the first `mcp-versions.test.ts` test passes alone in roughly 6--10 seconds,
  and the complete 20-test file passes and exits in roughly 57 seconds;
- the 16-worker default creates enough filesystem contention to push the first
  test past the unchanged 15-second test timeout; capping Vitest at four file
  workers made the focused test pass three consecutive times without leaving a
  child process;
- with that contention removed, the root run exposed a separate deterministic
  Windows `EPERM` race in `LocalL3AuthorityStateFile.acquireLock`: a failed
  candidate-directory rename can race with lock release, observe that the lock
  has disappeared, and rethrow the original `EPERM` instead of retrying.

The lock race is a security-sensitive runtime behavior issue, not a reason to
loosen the test timeout. Its decision and fix boundary belong to the recovery
track before contract inventory proceeds.

At capture time, the package-local scripts pointed to absent files:

- `packages/cli`: `packages/cli/src/testing/cli.test.ts`;
- `packages/mcp`: `packages/mcp/src/testing/mcp.test.ts`.

Source commit `c61027b` replaced both paths with their existing testing
directories; the CLI command then ran 3 files and 35 tests, while the MCP
command discovered 23 files and 214 tests.

## Reproduction commands

```bash
git status --short
git rev-parse HEAD
git rev-parse main
git rev-list -n 1 routeledger-plugin-v0.8.0
codegraph status
pnpm test
pnpm typecheck
pnpm lint
pnpm check:codex-plugin-release
```

Run `pnpm check:codex-plugin-release --require-tag-ref` only from the immutable
release-tag checkout or tag CI.

## Frozen NF1 boundary

NF1 may add tests, specifications, and internal collaborators while retaining
the current facade and observable contracts. It does not implicitly authorize:

- new product behavior, tools, states, schemas, or wire formats;
- changes to canonical JSON authority or deterministic bytes;
- weakened binding, exact authorization, claim/finalize, replay, concurrency,
  or fail-closed guarantees;
- recovery-policy changes hidden inside code movement;
- storage-boundary implementation before recovery semantics are settled;
- plugin release or SemVer changes without a separate release decision.
