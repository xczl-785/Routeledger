# RouteLedger core-contract evidence matrix

Status: NF1-03 initial inventory. Rows identify candidate requirement clusters;
they are not yet the normative text of the Core Specification.

Legend:

- `confirmed`: implemented and covered by executable evidence.
- `compatibility`: retained for historical/read compatibility, not a preferred
  new-write contract.
- `gap`: observed behavior or missing behavior that must not be normalized into
  a requirement without corrective work.
- `decision required`: evidence exists, but a product decision is still needed
  before normative wording is safe.

## Domain and work semantics

| ID | Contract cluster | Documentation / schema | Implementation symbols | Executable evidence | Status |
| --- | --- | --- | --- | --- | --- |
| RL-DOM-001 | Project is the logical route root; `currentVersionId` identifies the selected Version and `initialVersionId` is a legacy pointer. | `cap-route-work-semantics.md`; `agent-host-integration.md`; canonical `project.json` schema | `Project`; `initProject`; `RouteLedgerService.initProject` | `project-service.test.ts`; `service-version-workflow.test.ts`; `mcp-versions.test.ts` | confirmed |
| RL-DOM-002 | Version nodes form an ordered parent/sibling graph with one current pointer and explicit lifecycle state. | `cap-mcp-route-operations.md`; canonical Version schema | `Version`; `normalizeVersionTreePayload`; `applyVersionTreeMutation`; `prepareVersion`; `startVersion`; `markVersionComplete`; `closeVersion` | `version-service.test.ts`; `version-tree-service.test.ts`; `service-version-workflow.test.ts` | confirmed |
| RL-DOM-003 | WorkItem is a supporting Project-aggregate lineage identity, not a user work surface. Todo, Deferred, and readable legacy Undo records retain that ID across transitions; active WorkItems have exactly one active child record and closed WorkItems have none. | `cap-route-work-semantics.md`; `architecture/work-item-lineage-identity.md`; canonical Todo, Deferred, Undo, and WorkItem schemas | `WorkItem`; `validateWorkItemLineage`; Todo/Deferred operations in `RouteLedgerService`; aggregate validation | `work-item-service.test.ts`; `workflow-service.test.ts`; `json-validate.test.ts`; `sqlite-storage-adapter.test.ts` | confirmed |
| RL-DOM-004 | Deferred represents intentionally postponed work with a finite target review Version; review activates, re-defers, or resolves it explicitly. | `cap-route-work-semantics.md`; canonical Deferred schema | `DeferredItem`; `createDeferred`; `deferTodo`; `deferAgain`; `activateDeferred`; `resolveDeferred`; `validateDeferredRouteTarget` | `deferred-service.test.ts`; `deferred-application.test.ts`; `gate-service.test.ts`; `cli-deferred-constraint.test.ts` | confirmed |
| RL-DOM-005 | Constraint is a project- or Version-scoped rule, not a completion count; active constraints can block gates. | `cap-route-work-semantics.md`; canonical Constraint schema | `Constraint`; `createConstraint`; `retireConstraint`; `evaluateStartGate`; `evaluateCloseGate` | `constraint-service.test.ts`; `gate-service.test.ts`; `cli-deferred-constraint.test.ts` | confirmed |
| RL-DOM-006 | TransitionEvent is append-only audit evidence ordered by `(operationId, operationSeq)` and scoped to an existing target. | canonical TransitionEvent schema; `cap-canonical-json-contract.md` | `TransitionEvent`; `createTransitionEvents`; aggregate validation in `SQLiteStorageAdapter`; canonical codec | `asset-service.test.ts`; `service-version-workflow.test.ts`; `json-codec.test.ts`; `sqlite-storage-adapter.test.ts` | confirmed |
| RL-DOM-007 | Legacy Undo remains readable for audit and gates but has no current creation, mutation, or recommendation surface. | `cap-route-work-semantics.md`; `cap-canonical-json-contract.md`; legacy Undo schema | Undo decode path; current-context legacy projection; gate evaluation | `json-codec.test.ts`; `service-window-docdrift.test.ts`; `gate-service.test.ts` | compatibility |

## Canonical persistence and read model

| ID | Contract cluster | Documentation / schema | Implementation symbols | Executable evidence | Status |
| --- | --- | --- | --- | --- | --- |
| RL-JSON-001 | New canonical documents use schema version 2; supported readers retain the explicitly listed readable versions. | `cap-canonical-json-contract.md`; generated `routeledger.schema.json` | `ROUTELEDGER_SCHEMA_VERSION`; `ROUTELEDGER_READABLE_SCHEMA_VERSIONS`; `buildRouteLedgerSchemaDocument` | `json-validate.test.ts`; canonical fixture set; `public-export-guard.test.ts` | confirmed |
| RL-JSON-002 | Canonical encoding has deterministic paths, key ordering, undefined removal, permitted null preservation, and round-trip behavior. | `cap-canonical-json-contract.md`; canonical fixture set | `createCanonicalContent`; `stripUndefined`; `sortJsonValue`; `encodeProjectAggregateToJsonDocuments`; `decodeProjectAggregateFromJsonDocuments` | `json-codec.test.ts`; `json-validate.test.ts` | confirmed |
| RL-JSON-003 | Canonical JSON is runtime authority; SQLite, when enabled, is a rebuildable read model and conflicts fail closed. | `cap-json-first-runtime-storage.md`; `cap-sqlite-read-model-truth-source-boundary.md` | `JsonFirstStorageAdapter.loadProjectAggregate`; `saveProjectAggregate`; `SQLiteStorageAdapter` | `json-first-storage.test.ts`; `sqlite-storage-adapter.test.ts`; `cli-json.test.ts` | confirmed |
| RL-JSON-004 | Canonical replacement is staged and recoverable; explicit runtime `snapshot.headRevision` and writer locks reject stale snapshots without changing canonical bytes. | `cap-canonical-json-contract.md`; `cap-json-first-runtime-storage.md`; `cap-sqlite-read-model-truth-source-boundary.md` | `ProjectSnapshotReader`; `ProjectSnapshotWriter`; `JsonFirstStorageAdapter.saveProjectAggregate`; `SQLiteStorageAdapter.saveProjectAggregate` | `storage-port.test.ts`; `json-codec.test.ts`; `json-first-storage.test.ts`; `sqlite-storage-adapter.test.ts` | confirmed |
| RL-JSON-005 | Host-owned exact-authorization state is outside canonical project JSON and is not project-file authority. | `agent-host-integration.md`; `exact-authorization-contract.md` | `ExactAuthorizationStore`; `LocalL3AuthorityStateFile`; exact receipt verification in `RouteLedgerService` | `exact-authorization-store.test.ts`; `local-l3-authorization.test.ts`; `execute-l3-operation.test.ts` | confirmed |

## Binding and physical roots

| ID | Contract cluster | Documentation / schema | Implementation symbols | Executable evidence | Status |
| --- | --- | --- | --- | --- | --- |
| RL-BIND-001 | A binding identifies an absolute workspace root and one contained RouteLedger root; physical resolution prevents lexical or symlink escape. | `agent-host-integration.md`; `cap-json-first-runtime-storage.md` | `resolveRouteLedgerBinding`; `resolvePhysicalPathForContainmentSync`; `isPhysicalPathContainedWithinSync`; `arePhysicalPathsEqualSync` | `mcp-binding.test.ts`; `mcp-write-guards.test.ts`; `local-l3-authorization.test.ts` | confirmed |
| RL-BIND-002 | One MCP server process owns one binding; runtime source and process cwd do not select the managed project. | `agent-host-integration.md`; `cap-mcp-route-operations.md` | binding state in `createRouteLedgerMcpRegistry`; `resolveRouteLedgerBinding`; `activate_routeledger_binding` handler | `mcp-binding.test.ts`; `mcp-runtime-context.test.ts`; `mcp-registry-protocol.test.ts` | confirmed |
| RL-BIND-003 | Binding-sensitive writes and high-risk previews require an exact absolute `expectedRouteLedgerRoot` before entering a write path. | `cap-mcp-route-operations.md`; tool input schemas | `runBindingPreflight`; ordered capability tool factories in `packages/mcp/src/capabilities/`; shared decoration in `packages/mcp/src/registry/tool-contract.ts` | `mcp-write-guards.test.ts`; `mcp-runtime-context.test.ts`; `mcp-versions.test.ts` | confirmed |
| RL-BIND-004 | `.routeledger/config.json` resolves `dataRoot`; canonical data lives below `<dataRoot>/.routeledger/` and mismatched configuration fails closed. | `agent-host-integration.md`; `cap-json-first-runtime-storage.md`; workspace config version 1 | `resolveWorkspaceConfigSync`; `JsonFirstStorageAdapter` constructor | `mcp-binding.test.ts`; `json-first-storage.test.ts`; `mcp-runtime-context.test.ts` | confirmed |

## Route lifecycle and graph

| ID | Contract cluster | Documentation / schema | Implementation symbols | Executable evidence | Status |
| --- | --- | --- | --- | --- | --- |
| RL-ROUTE-001 | Preparation and start are distinct transitions; start uses an evaluated start gate and preserves one current Version. | `cap-mcp-route-operations.md`; Version schema | `prepareVersion`; `evaluateStartGate`; `startVersion`; `RouteLedgerService.prepareVersion` | `version-service.test.ts`; `gate-service.test.ts`; `service-version-workflow.test.ts`; `mcp-versions.test.ts` | confirmed |
| RL-ROUTE-002 | Completion and ordinary close are distinct; close requires a passing close gate and explicit residual-audit evidence. | `cap-mcp-route-operations.md`; pending-operation residual-audit payload schema | `markVersionComplete`; `normalizeResidualAudit`; `resolveResidualAudit`; `evaluateCloseGate`; `summarizeVersionCloseoutApplication`; `planVersionCloseoutApplication`; `closeVersion` | `gate-service.test.ts`; `version-closeout-application.test.ts`; `service-closeout.test.ts`; `mcp-versions.test.ts` | confirmed |
| RL-ROUTE-003 | Reopen and shutdown have explicit state reasons and different safety semantics; shutdown is an emergency L3 route change. | `cap-mcp-route-operations.md`; Version and PendingOperation schemas | `reopenVersion`; `shutdownVersion`; corresponding `RouteLedgerService` proposal/commit branches | `version-service.test.ts`; `service-version-workflow.test.ts`; `mcp-versions.test.ts` | confirmed |
| RL-ROUTE-004 | Closed history is immutable except for an append-only top-level successor; insertion, reordering, reparenting, and children under closed history are rejected. | `cap-mcp-route-operations.md` | `normalizeVersionTreePayload`; `applyVersionTreeMutation`; closed-anchor guards in `version-tree-service.ts` | `version-tree-service.test.ts`; `service-version-workflow.test.ts`; `mcp-versions.test.ts` | confirmed |
| RL-ROUTE-005 | Forward advancement to a ready direct successor switches current and starts it under one L3 proposal and aggregate save; blocked gates create no proposal. | `cap-mcp-route-operations.md` | `advanceToVersion`; L3 application branch in `RouteLedgerService`; `evaluateStartGate` | `service-version-workflow.test.ts`; `mcp-versions.test.ts`; `execute-l3-operation.test.ts` | confirmed |
| RL-ROUTE-006 | `next_action` is a deterministic shared recommendation with blocker precedence; stable record order is not business priority. | `cap-mcp-route-operations.md` | current-context/next-action query functions; `RouteLedgerService.getNextAction` | `service-next-action.test.ts`; `mcp-versions.test.ts` | confirmed |

## L3 decision and commit protocol

| ID | Contract cluster | Documentation / schema | Implementation symbols | Executable evidence | Status |
| --- | --- | --- | --- | --- | --- |
| RL-L3-001 | Every high-risk route change begins as one PendingOperation with immutable action, target, payload, gate snapshot, and operation digest. | `l3-route-transition-decision-protocol.md`; `exact-authorization-contract.md`; PendingOperation schema | proposal builders and digest functions in `RouteLedgerService`; `createExactProposalDecisionRequest` | `service-approval.test.ts`; `l3-decision.test.ts`; `execute-l3-operation.test.ts` | confirmed |
| RL-L3-002 | A trusted decision is exact to proposal, project, physical root digest, action, target, and operation digest; host modes cannot widen that tuple. | `l3-route-transition-decision-protocol.md`; `exact-authorization-contract.md`; exact schema version 2 | `ExactAuthorizationBinding`; `assertDecisionResolutionMatchesRequest`; authorization candidate validators/adapters | `exact-authorization-contract.test.ts`; `l3-authorization.test.ts`; `codex-l3-decision-adapter.test.ts`; `existing-l3-decision-adapter.test.ts` | confirmed |
| RL-L3-003 | ApprovalArtifact is canonical audit projection; the separate host-owned receipt is executable authority and is consumed once. | `agent-host-integration.md`; `exact-authorization-contract.md`; ApprovalArtifact schema | `projectDecisionArtifact`; `ExactAuthorizationStore.consumeAndRecordReceipt`; `RouteLedgerService.getExactArtifactReceiptBinding` | `exact-authorization-store.test.ts`; `service-authorization-grant.test.ts`; `approval-list-contract.test.ts` | confirmed |
| RL-L3-004 | Commit verifies live state, claims the receipt, applies one aggregate mutation, saves canonical state, and finalizes the receipt in that order. | `l3-route-transition-decision-protocol.md`; `exact-authorization-contract.md`; `nf1-recovery-and-storage-decision.md` | `RouteLedgerService.commitL3OperationOwned`; `ExactAuthorizationStore.claimCommit`; `finalizeCommit` | `service-approval.test.ts`; `service-authorization-grant.test.ts`; `execute-l3-operation.test.ts`; `exact-authorization-store.test.ts` | confirmed |
| RL-L3-005 | Retry is exact replay only: the same artifact, identities, digest, and stable receipt claim may recover finalization without repeating the canonical mutation; mismatches fail closed. | `l3-route-transition-decision-protocol.md`; `exact-authorization-contract.md` | committed replay branch in `commitL3OperationOwned`; `buildAuthorizationCommitClaimId`; `claimCommit`; `finalizeCommit` | `service-authorization-grant.test.ts`; `execute-l3-operation.test.ts`; `local-l3-authorization-profile-runtime.test.ts` | confirmed |
| RL-L3-006 | Local authority state-file locking uses owner identity, heartbeat, live-process checks, revision checks, and stale-owner recovery without time-only takeover. | `agent-host-integration.md`; `nf1-recovery-and-storage-decision.md`; host state schema version 2 | `LocalL3AuthorityStateFile.acquireLock`; heartbeat/ownership/revision helpers | `local-l3-authorization.test.ts`; `local-l3-authorization-profile-runtime.test.ts` | confirmed |
| RL-L3-007 | Persisted exact commit coordination recovers an expired owner only when process death is definitive, increments a fencing generation, and replays all four crash windows without repeating the canonical mutation. Live or unknown ownership fails closed. | `nf1-recovery-and-storage-decision.md`; local authority state schema version 3 | `ExactCommitCoordinator`; `MemoryExactCommitCoordinator`; `PersistentLocalExactCommitCoordinator`; `RouteLedgerService.commitL3Operation` | `exact-commit-coordinator.test.ts`; `service-authorization-grant.test.ts`; `local-l3-authorization.test.ts` | confirmed |

## Initial drafting gaps

The matrix exposes three documentation tasks before a normative v0.1 draft can
claim coverage:

1. Assign clause-level requirement IDs beneath these clusters and link each
   clause back to a row.
2. `RL-L3-GAP-001` was closed as `RL-L3-007` after safe takeover, fencing,
   migration, and the four crash-window acceptance cases shipped in Stage 1.

Symbol names in this inventory are deliberately implementation references, not
language-agnostic API requirements. Refactoring may move them as long as the
contract and tests remain stable and this matrix is updated.
