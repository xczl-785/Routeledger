# RouteLedger code health audit and refactoring roadmap

Status: active roadmap  
Audit baseline: `routeledger-plugin-v0.10.4` (`3a709745`)  
Audit date: 2026-08-21

## Purpose

This document turns the post-0.10.4 code-health audit into an ordered,
verifiable refactoring program. The objective is to preserve RouteLedger's
correctness and fail-closed behavior while reducing the cost and risk of each
future Version.

The roadmap is deliberately incremental. Each stage must leave the repository
in a releasable state, retain compatibility unless the stage explicitly owns a
migration, and introduce focused tests before changing production behavior.

## Executive assessment

RouteLedger is healthy enough to continue evolving, but complexity has become
concentrated in a small number of application, transport, serialization, and
storage modules. Package-level dependency direction is generally sound and the
audit found no package-level dependency cycle. Security-sensitive L3 behavior
and canonical JSON behavior have comparatively strong automated coverage.

The principal risk is no longer a lack of functionality. It is that large
facades, broad persistence contracts, and duplicated boundary logic make a
seemingly local change affect too much of the system.

| Dimension | Score | Assessment |
| --- | ---: | --- |
| Correctness and security | 8.5/10 | Strong fail-closed contracts and L3 test evidence, with one critical recovery gap. |
| Layering | 7/10 | Package direction is sound; some core and transport boundaries leak infrastructure concerns. |
| Cohesion | 5.5/10 | Several files own too many unrelated use cases. |
| Coupling | 6/10 | Aggregate-wide storage and cross-package source inclusion increase change radius. |
| Test protection | 8/10 | Broad behavior coverage; crash recovery, UI process paths, and coverage thresholds need work. |
| Sustainable evolution | 6/10 | Safe today, but continued feature growth will compound concentrated complexity. |
| Overall | **7/10** | Good foundations with structural debt that should now be paid down deliberately. |

## Findings

### 1. Critical: L3 commit ownership cannot recover from process death

`ExactAuthorizationStoreState.commitOwners` persists a random owner ID without
a process identity, lease, fencing token, or safe takeover rule. Normal
concurrency releases ownership in `finally`, but a process that dies cannot run
that cleanup. A restarted process can therefore be rejected before it reaches
the stable receipt replay path that would otherwise recover the operation.

Evidence and current decision record:

- `packages/core/src/application/exact-authorization-store.ts`
- `packages/core/src/application/routeledger-service.ts`
- `docs/architecture/nf1-recovery-and-storage-decision.md`
- `docs/specification/core-contract-evidence-matrix.md` (`RL-L3-GAP-001`)

This is the first refactoring stage because it is a correctness and
availability gap at a security-sensitive boundary, not merely a code-shape
problem.

### 2. High: the application facade is a complexity hotspot

`RouteLedgerService` is approximately 6,255 lines and owns queries, ordinary
writes, Version lifecycle operations, batch behavior, approval processing, and
L3 orchestration. These responsibilities share state access but do not all
share the same reason to change.

The service should be reduced through use-case extraction, not a file-only
split. Query, batch, Version lifecycle, and L3 services should have explicit
inputs and depend on narrow ports. `RouteLedgerService` can remain as a
compatibility facade while callers migrate.

### 3. High: persistence is coupled to the full aggregate

The storage boundary loads and saves the full project aggregate for many use
cases. Hidden revision metadata is attached through a `Symbol`, which makes the
concurrency contract difficult to discover and difficult for adapters to
implement independently.

The first storage improvement should make revision/concurrency tokens explicit.
Splitting read and write capabilities should happen only after application use
cases have narrower boundaries; otherwise the project would merely duplicate a
broad interface under new names.

### 4. Medium-high: JSON codec and validator evolve together

The canonical JSON codec and validator are both large and have a type-level
cycle. Adding or changing a field requires coordinated edits across multiple
large switch/validation structures.

A central entity/field descriptor should become the source for repeated
serialization, validation, canonical ordering, and schema metadata. Adoption
must be incremental and guarded by byte-for-byte canonical fixtures.

### 5. Medium-high: MCP transport concerns are concentrated

The MCP entrypoint and stdio server combine registration, input parsing,
binding, authorization, execution, response projection, error mapping, and
logging. Response-detail work has shown that these cross-cutting concerns are
now expensive to change consistently.

The target is an explicit pipeline:

`validate -> bind -> authorize -> execute -> project response -> map error`

Tool capabilities should retain domain-specific handlers; middleware should
own only cross-cutting transport policy.

### 6. Medium: core contains direct filesystem concerns

Document-drift behavior in core reaches directly into filesystem/path APIs.
The domain decision belongs in core, but file discovery and reading should be
provided through a narrow document-source port implemented by the host layer.

### 7. Medium: TypeScript configuration weakens package boundaries

Cross-package source inclusion allows code to compile even when package public
exports or dependency declarations are incomplete. This reduces the value of
the package graph as an architectural guardrail.

Boundary enforcement should be introduced with a check-only phase first, then
package references/exports can be tightened one package at a time.

### 8. Medium: additional large boundary modules

The CLI entrypoint, SQLite adapter, and UI launcher contain repeated path,
binding, and process concerns. Physical RouteLedger-root resolution in
particular should have one shared policy with adapters at each boundary.

These modules should be addressed after core and MCP boundaries stabilize so
that they can depend on the resulting contracts rather than invent temporary
ones.

### 9. Medium: test depth is uneven at process boundaries

The suite is broad and protects core/MCP behavior well, but there is no enforced
coverage threshold. UI HTTP/process paths are thinner than core paths, and the
known L3 crash windows do not have executable restart acceptance tests.

Coverage numbers should be used as a regression guard, not as a substitute for
scenario tests. Crash/restart tests are part of Stage 1, while UI/process and
repository-wide thresholds belong later in the roadmap.

### 10. Medium: WorkItem identity needs an explicit decision

WorkItem identity and lifecycle semantics are implemented but not sufficiently
explicit as an architectural contract. Before storage interfaces are split,
the project should decide whether WorkItem is an aggregate member, an
independently addressed entity, or a projection of other workflow state.

## Ordered refactoring program

| Order | Audit group | Stage | Primary outcome | Stage verification |
| ---: | :---: | --- | --- | --- |
| 1 | A | L3 crash recovery | Recover abandoned commit ownership without widening exact authorization. | Crash-window, restart, fencing, migration, and concurrent replay tests pass. |
| 2 | B | Canonical JSON descriptors | Remove repeated codec/validator structure and the type-only cycle incrementally. | Existing canonical bytes and validation results remain unchanged. |
| 3 | B | Package boundary enforcement | Make forbidden source imports and undeclared dependencies visible. | CI check passes without broad cross-package source inclusion. |
| 4 | B | Extract query, batch, and Version use cases | Reduce `RouteLedgerService` responsibilities behind compatible APIs. | Existing public API and behavior tests pass; facade delegates to narrow services. |
| 5 | C | Extract L3 application service | Isolate security-sensitive orchestration after recovery semantics stabilize. | L3 protocol, recovery, replay, and authorization suites remain green. |
| 6 | C | MCP middleware pipeline | Centralize cross-cutting transport policy. | Tool contract snapshots and agent response behavior remain stable. |
| 7 | C | Introduce document-source port | Remove direct filesystem access from core domain decisions. | Core tests run with an in-memory port; host adapters pass integration tests. |
| 8 | D | Decide WorkItem identity | Record and enforce aggregate/identity ownership. | ADR accepted and domain/storage tests express the chosen invariant. |
| 9 | D | UI/process tests and coverage guard | Protect currently thin runtime boundaries. | Agreed thresholds and native process scenarios run in CI. |
| 10 | D | Evolve storage boundary | Expose explicit revisions and narrower read/write capabilities. | JSON and SQLite adapters pass stale-write, migration, and compatibility suites. |

## Combined audit gates

Stage verification and architecture audit are separate activities. Each stage
keeps the nearest useful automated checks, but a scheduled independent audit
runs only after its audit group is complete. Small commits and incremental
delivery remain encouraged; they do not create additional approval gates.

| Gate | Included stages | One-time audit focus | Repository gate |
| :---: | --- | --- | --- |
| A | 1 | Recovery safety, persisted-state migration, owner liveness, fencing, and fail-closed behavior. | Full workspace tests, typecheck, lint, and release-sensitive smoke checks at Stage 1 closure. |
| B | 2-4 | Canonical-byte compatibility, dependency direction, package exports, and facade compatibility after use-case extraction. | Full workspace gates once after Stage 4. |
| C | 5-7 | Application/transport/host boundaries, L3 invariant preservation, middleware consistency, and filesystem-port isolation. | Full workspace gates once after Stage 7. |
| D | 8-10 | Domain identity, explicit revision semantics, storage migrations, adapter compatibility, and process-boundary regression protection. | Full workspace and release gates once after Stage 10. |

This reduces the planned independent architecture audits from ten to four.
Stages 2-7 are intentionally split across two gates: combining all six would
make the review surface too broad to locate boundary regressions efficiently.

An unscheduled focused audit is allowed only when implementation changes a
persisted schema or migration rule, a public cross-package contract, or an L3
fail-closed invariant. A failing test or unexpected cross-boundary regression
may also trigger one. These are exception reviews, not new standing gates.

## Stage 1: L3 crash recovery delivery plan

### Protected behavior

- Exact authorization remains bound to one proposal, project, physical root,
  action, target, operation digest, and approval artifact.
- One logical mutation may be committed at most once.
- A stale process must never finalize or release ownership held by a newer
  process.
- A restart may recover only the original exact operation; it must never widen
  authority or substitute another proposal.
- Old persisted state must either migrate deterministically or fail closed with
  an actionable compatibility error.

### Required design elements

The persisted random owner string must be replaced by a versioned coordination
record with enough information to make a safe decision after restart. The
design must define:

- stable operation/claim identity;
- owner instance identity;
- monotonically increasing fencing generation;
- liveness or lease evidence and its clock assumptions;
- takeover rules for abandoned ownership;
- release/finalize preconditions;
- old-state migration and old-binary rejection behavior.

The coordination record remains host-owned exact-authorization state. It must
not become canonical RouteLedger project data.

### TDD sequence

1. Add a focused state-store test that imports an abandoned owner and proves a
   restarted store cannot currently recover it.
2. Add generation/fencing tests proving a stale owner cannot release or
   finalize a newer claim.
3. Add service-level crash-window tests for:
   - ownership acquired before receipt claim;
   - receipt claimed before canonical save;
   - canonical save completed before receipt finalization;
   - receipt finalized before ownership release.
4. Add concurrent duplicate-call and exact-mismatch cases.
5. Add old-state migration and malformed-state fail-closed cases.
6. Implement the smallest versioned coordination state that makes each test
   green, then refactor names and boundaries while the focused suites remain
   green.

### Stage 1 completion evidence

- `RL-L3-GAP-001` is replaced by confirmed contract `RL-L3-007` in the evidence
  matrix.
- The recovery decision document records the implemented protocol, verified
  crash windows, and rejected alternatives.
- Focused core tests, MCP execution tests, full workspace tests, typecheck, and
  lint pass.
- No generated plugin runtime changes are accepted without the normal release
  provenance and plugin smoke checks.

Delivery commits through Gate A implementation:

- `26987ef` introduces the independent coordinator and fencing model;
- `3343674` migrates local authority state to schema version 3;
- `ffd7472` encapsulates host-owned process identity;
- `aff8ad5` persists coordinator leases in local authority state;
- `ee61fcf` wires recoverable ownership through Core, CLI, and MCP; and
- `9ce92ac` fences the receipt claim before durable commit boundaries; and
- `faf7d02` closes the four-window recovery acceptance evidence and contract
  documentation.

Gate A closed on 2026-08-21 with zero blocking and zero non-blocking correctness
findings in the one scheduled independent audit. Full repository verification:
78 test files passed, with 749 tests passed and 1 skipped; typecheck and lint
passed. Stage 2 is now the active entry point for audit group B.

## Working rules for every stage

1. Start from a failing behavior or boundary test where practical.
2. Keep compatibility facades until all internal callers have migrated.
3. Do not combine behavior changes with broad formatting or unrelated file
   movement.
4. Record architectural decisions before introducing persisted schemas or
   cross-package contracts.
5. Use focused tests during RED/GREEN and run the affected package before each
   stage is considered verified. Run full repository gates at the combined
   audit gate and before a release merge, rather than after every stage.
6. Update this roadmap after each audit group with the delivered commits/PRs,
   evidence, residual risk, and the next group's entry conditions. Individual
   stage progress may be recorded without opening an audit.

## Proportional governance

The roadmap must reduce engineering friction as well as technical risk. Review
depth is proportional to the boundary being changed:

- L3 authorization, persisted schema, migration, concurrency, and cross-package
  public contracts require a written decision and focused failure/recovery
  evidence.
- Use-case extraction behind an unchanged public facade requires focused tests,
  typecheck, and review of the affected package; it does not require a new ADR
  for each extracted class or file.
- Mechanical moves, naming improvements, and private helper extraction require
  only the nearest useful tests and static checks.
- Full-repository gates run at combined audit-group completion and before a
  release merge, not after every stage or small edit.
- Scheduled subagent architecture reviews run once per combined audit group.
  During implementation, subagents may still own bounded coding or test tasks,
  but their completion is not an additional approval layer.

Audit findings should identify actionable coupling or correctness risk at the
module/use-case boundary. Line-by-line style observations and speculative
future abstractions are out of scope unless they block the current stage.
