import crypto from "node:crypto";

import type { Actor } from "../domain/actor.js";
import type {
  IdempotencyResultMetadata,
  OrdinaryWriteCommandName,
  OrdinaryWriteReceipt
} from "./ordinary-write-idempotency.js";
import type { Constraint, ConstraintScope } from "../domain/constraint.js";
import type { DeferredItem } from "../domain/deferred-item.js";
import {
  buildShutdownStateReason,
  describeVersionState
} from "../domain/route-semantics.js";
import type { Todo } from "../domain/todo.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import type { Undo } from "../domain/undo.js";
import type { Version } from "../domain/version.js";
import type { WorkItem } from "../domain/work-item.js";
import {
  type ProjectSnapshotReader,
  type ProjectSnapshotWriter,
  type ProjectAggregateSnapshot
} from "../ports/storage-port.js";
import type { DocumentSourcePort } from "../ports/document-source-port.js";
import {
  assertDeferredRouteTarget,
  evaluateCloseGate,
  evaluateStartGate,
  resolveResidualAudit,
  type GateBlocker,
  type CloseGateResult,
  type ResidualAuditInput,
  type StartGateResult
} from "../services/gate-service.js";
import type { DomainDependencies } from "../services/operation.js";
import {
  createProject,
  setProjectContentLocale as setProjectContentLocaleDomain
} from "../services/project-service.js";
import { normalizeVersionTreePayload } from "../services/version-tree-service.js";
import {
  closeTodo as closeTodoDomain,
  createTodo as createTodoDomain
} from "../services/work-item-service.js";
import {
  deferWork as deferWorkWorkflow,
  recordConstraint as recordConstraintWorkflow,
  retireRecordedConstraint,
  reviewDeferred as reviewDeferredWorkflow
} from "../services/workflow-service.js";

import { ApplicationError } from "./errors.js";
import {
  resolveProposalReason,
  type ResolvedProposalReason
} from "./proposal-reason.js";
import type { ExactAuthorizationStore } from "./exact-authorization-store.js";
import type { ExactCommitCoordinator } from "./exact-commit-coordinator.js";
import {
  buildDerivedCurrentContextData
} from "./current-context-query.js";
import {
  RouteLedgerQueryService,
  type RouteLedgerVersionQueryUseCases
} from "./routeledger-query-service.js";
import { persistProjectAggregate } from "./project-aggregate-access.js";
import {
  VersionCommandService,
  type VersionCommandUseCases
} from "./version-command-service.js";
import {
  L3ProposalReadService,
  type GetL3AuthorizationEvaluationContextInput,
  type RecommendBalancedL3AuthorizationPolicyInput
} from "./l3-proposal-read-service.js";
import { rebuildCanonicalL3ProposalDigest } from "./l3-proposal-security-port.js";
import type {
  L3ProposalSecurityDescription,
  L3ProposalSecurityPort
} from "./l3-proposal-security-port.js";
import {
  L3ProposalWriteService,
  type L3ProposalWriteUseCases
} from "./l3-proposal-write-service.js";
import {
  L3LegacyApprovalService,
  type L3LegacyApprovalUseCases
} from "./l3-legacy-approval-service.js";
import {
  L3ExactAuthorizationService,
  type L3ExactAuthorizationUseCases,
  type TrustedL3AuthorizationControlPlane
} from "./l3-exact-authorization-service.js";
import {
  L3OperationCommitService,
  type L3OperationCommitUseCases
} from "./l3-operation-commit-service.js";
import type { CheckDocDriftInput, CheckDocDriftResult } from "./doc-drift-query.js";
import {
  inspectEntryDocumentCoverage,
  runDocDriftCheck
} from "./doc-drift-query.js";
import type { VersionCloseoutPlan } from "./version-closeout-planner.js";
import {
  isSelfReferentialUndoForVersion
} from "./version-closeout-query.js";
import type { VersionCloseoutSummary } from "./version-closeout-query.js";
import type {
  PlanVersionCloseoutInput,
  SummarizeVersionCloseoutInput
} from "./version-closeout-application.js";
import {
  evaluateBatchCreateVersions
} from "./batch-create-versions-planner.js";
import {
  isRouteOperationWorkflowMode,
  type RouteOperationWorkflowMode
} from "./types.js";
import type {
  ApprovalArtifact,
  CloseGateSnapshot,
  GateSnapshot,
  L3ActionType,
  NoopGateSnapshot,
  OperationDigest,
  PendingOperation,
  PendingOperationPayload,
  ShutdownGateSnapshot,
  StartGateSnapshot
} from "./types.js";
export type {
  BatchCreateVersionsFailure,
  BatchCreateVersionsNormalizedPlan,
  BatchCreateVersionsPlanSummary,
  BatchCreateVersionsPreview,
  BatchCreateVersionsPreviewTodo,
  BatchCreateVersionsPreviewVersion
} from "./batch-create-versions-planner.js";
import {
  BatchCreateVersionsUseCase,
  buildBatchSnapshotHash,
  type BatchCreateVersionsExecutor,
  type BatchCreateVersionsInput,
  type BatchCreateVersionsResult
} from "./batch-create-versions-use-case.js";
export type {
  BatchCreateVersionsInput,
  BatchCreateVersionsPreflightResult,
  BatchCreateVersionsPreflightSuccess,
  BatchCreateVersionsProposeSuccess,
  BatchCreateVersionsResult
} from "./batch-create-versions-use-case.js";
export type {
  CheckDocDriftCheckedFile,
  CheckDocDriftExpectedPointer,
  CheckDocDriftInput,
  CheckDocDriftResult,
  CheckDocDriftSuggestedTodo,
  CheckDocDriftUnreadableFile,
  CheckDocDriftWarning
} from "./doc-drift-query.js";
export type {
  VersionCloseoutPlan,
  VersionCloseoutPlanRequiredInput,
  VersionCloseoutPlanStatus,
  VersionCloseoutPlanStep,
  VersionCloseoutPlanStepKind
} from "./version-closeout-planner.js";
export type { VersionCloseoutSummary } from "./version-closeout-query.js";
export type {
  PlanVersionCloseoutInput,
  SummarizeVersionCloseoutInput
} from "./version-closeout-application.js";

type RouteLedgerStorage = ProjectSnapshotReader & ProjectSnapshotWriter;

export interface RouteLedgerServiceOptions {
  storage: RouteLedgerStorage;
  deps: DomainDependencies;
  queryService?: RouteLedgerVersionQueryUseCases;
  versionCommandService?: VersionCommandUseCases;
  batchCreateVersionsUseCase?: BatchCreateVersionsExecutor;
  documentSource?: DocumentSourcePort;
  l3Authorization?: {
    exactStore: ExactAuthorizationStore;
    commitCoordinator: ExactCommitCoordinator;
    audience: string;
    subjectId: string;
    routeledgerRootDigest: string;
    profileId?: string;
    modeEpoch?: number;
    profileDigest?: string;
    hostKind: string;
    clientId?: string;
  };
}

/** Reader-only version-structure projection, shared by hosts that cannot write. */
export const buildVersionStructureView = (
  snapshot: ProjectAggregateSnapshot,
  input: GetVersionStructureInput
): VersionStructureView => {
  const focusVersionId = input.versionId ?? snapshot.project.currentVersionId;

  if (focusVersionId === null) {
    throw new ApplicationError("VERSION_NOT_FOUND", "project 当前没有 current version", {
      projectId: input.projectId
    });
  }

  const focusVersion = requireVersion(snapshot, focusVersionId);
  const currentVersion =
    snapshot.project.currentVersionId === null
      ? null
      : requireVersion(snapshot, snapshot.project.currentVersionId);
  const siblings = snapshot.versions
    .filter((version) => version.parentVersionId === focusVersion.parentVersionId)
    .sort((left, right) => left.order - right.order)
    .map(summarizeVersion);
  const childVersions = snapshot.versions
    .filter((version) => version.parentVersionId === focusVersion.id)
    .sort((left, right) => left.order - right.order)
    .map(summarizeVersion);
  const openTodos = snapshot.todos
    .filter(
      (todo) =>
        todo.versionId === focusVersion.id &&
        (todo.status === "wait" || todo.status === "running")
    )
    .map(summarizeOpenTodo);
  const openWaitUndos = snapshot.undos
    .filter((undo) => undo.status === "wait")
    .map(summarizeVersionStructureUndo);

  return {
    project: {
      id: snapshot.project.id,
      currentVersionId: snapshot.project.currentVersionId
    },
    focusVersion: summarizeVersionStructureVersion(focusVersion),
    currentVersion: currentVersion === null ? null : summarizeCurrentVersion(currentVersion),
    parentVersion:
      focusVersion.parentVersionId === null
        ? null
        : summarizeVersion(requireVersion(snapshot, focusVersion.parentVersionId)),
    siblings,
    childVersions,
    openTodos,
    openUndos: {
      owned: openWaitUndos.filter((undo) => undo.versionId === focusVersion.id),
      origin: openWaitUndos.filter((undo) => undo.originVersionId === focusVersion.id),
      preferredResolution: openWaitUndos.filter(
        (undo) => undo.preferredResolutionVersionId === focusVersion.id
      )
    },
    legalOperations: buildVersionStructureLegalOperations(
      snapshot,
      focusVersion,
      input.residualAudit
    )
  };
};

export interface InitProjectInput {
  name: string;
  description?: string;
  contentLocale: string;
  firstVersion?: {
    title: string;
    description?: string;
    initialTodos: string[];
  } | null;
  actor: Actor;
}

export interface SetProjectContentLocaleCommandInput {
  projectId: string;
  contentLocale: string;
  reason: string;
  actor: Actor;
}

export interface VersionCommandInput {
  projectId: string;
  versionId: string;
  actor: Actor;
}

export interface CloseVersionCommandInput extends VersionCommandInput {
  residualAudit?: ResidualAuditInput;
}

export interface ShutdownVersionCommandInput extends VersionCommandInput {
  shutdownReason: string;
  reason?: string;
}

export interface TransitionVersionInput extends VersionCommandInput {
  mode?: RouteOperationWorkflowMode;
  reason?: string;
}

export interface CloseVersionWorkflowInput extends CloseVersionCommandInput {
  mode?: RouteOperationWorkflowMode;
  reason?: string;
}

export interface ShutdownVersionWorkflowInput extends ShutdownVersionCommandInput {
  mode?: RouteOperationWorkflowMode;
}

export interface GetVersionTransitionGuideInput {
  projectId: string;
  fromVersionId?: string;
  targetVersionId: string;
  residualAudit?: ResidualAuditInput;
}

export interface CreateTodoCommandInput {
  projectId: string;
  versionId: string;
  title: string;
  description?: string;
  /** W1 protected path. MCP makes this mandatory for all ordinary writes in W2. */
  idempotencyKey?: string;
  actor: Actor;
}

export interface CreateTodoCommandResult {
  todo: Todo;
  workItem: WorkItem;
  events: TransitionEvent[];
  idempotency?: IdempotencyResultMetadata;
}

export interface CloseTodoCommandInput {
  projectId: string;
  todoId: string;
  reason: string;
  note: string;
  idempotencyKey?: string;
  actor: Actor;
}

export type DeferWorkCommandInput =
  | {
      mode: "new";
      projectId: string;
      originVersionId?: string;
      targetReviewVersionId: string;
      title: string;
      description?: string;
      reason: string;
      reviewTrigger?: string | null;
      idempotencyKey?: string;
      actor: Actor;
    }
  | {
      mode: "todo";
      projectId: string;
      todoId: string;
      targetReviewVersionId: string;
      reason: string;
      note: string;
      reviewTrigger?: string | null;
      idempotencyKey?: string;
      actor: Actor;
    };

export type DeferWorkCommandResult = (
  | {
      mode: "new";
      deferred: DeferredItem;
      workItem: WorkItem;
      events: TransitionEvent[];
    }
  | {
      mode: "todo";
      todo: Todo;
      deferred: DeferredItem;
      workItem: WorkItem;
      events: TransitionEvent[];
    }
) & { idempotency?: IdempotencyResultMetadata };

export type ReviewDeferredCommandInput =
  | {
      action: "activate";
      projectId: string;
      deferredId: string;
      targetVersionId: string;
      reason: string;
      note?: string;
      idempotencyKey?: string;
      actor: Actor;
    }
  | {
      action: "defer_again";
      projectId: string;
      deferredId: string;
      targetReviewVersionId: string;
      reason: string;
      note?: string;
      reviewTrigger?: string | null;
      idempotencyKey?: string;
      actor: Actor;
    }
  | {
      action: "resolve";
      projectId: string;
      deferredId: string;
      outcome: "superseded" | "rejected" | "out_of_scope";
      reason: string;
      note?: string;
      decisionRef?: string | null;
      idempotencyKey?: string;
      actor: Actor;
    };

export type ReviewDeferredCommandResult = (
  | {
      action: "activate";
      deferred: DeferredItem;
      todo: Todo;
      workItem: WorkItem;
      events: TransitionEvent[];
    }
  | {
      action: "defer_again";
      deferred: DeferredItem;
      workItem: WorkItem;
      events: TransitionEvent[];
    }
  | {
      action: "resolve";
      deferred: DeferredItem;
      workItem: WorkItem;
      events: TransitionEvent[];
    }
) & { idempotency?: IdempotencyResultMetadata };

export interface RecordConstraintCommandInput {
  projectId: string;
  rule: string;
  rationale: string;
  scope: ConstraintScope;
  idempotencyKey?: string;
  actor: Actor;
}

export interface RecordConstraintCommandResult {
  constraint: Constraint;
  events: TransitionEvent[];
  idempotency?: IdempotencyResultMetadata;
}

export interface RetireConstraintCommandInput {
  projectId: string;
  constraintId: string;
  reason: string;
  note: string;
  idempotencyKey?: string;
  actor: Actor;
}

export interface RetireConstraintCommandResult {
  constraint: Constraint;
  events: TransitionEvent[];
  idempotency?: IdempotencyResultMetadata;
}

export interface GetCurrentContextInput {
  projectId: string;
  budgetBytes?: number;
  includeAllVersions?: boolean;
  versionWindowBefore?: number;
  versionWindowAfter?: number;
  includeLegacyUndo?: boolean;
}

export interface ListVersionsWindowInput {
  projectId: string;
  aroundVersionId?: string;
  before?: number;
  after?: number;
}

export interface ProposeL3OperationInput {
  projectId: string;
  actionType: L3ActionType;
  targetId: string;
  reason: string;
  actor: Actor;
  payload?: PendingOperationPayload;
  /** Internal workflow guard: fail before persistence when the computed gate is blocked. */
  requirePassingGate?: boolean;
}

export interface ApproveL3OperationInput {
  projectId: string;
  pendingOperationId: string;
  approver: Actor;
  actor: Actor;
  decisionRef?: string;
  expiresAt?: string;
}

export interface AuthorizeL3OperationInput {
  projectId: string;
  pendingOperationId: string;
  authorizationId: string;
  actor: Actor;
}

export interface CommitL3OperationInput {
  projectId: string;
  pendingOperationId: string;
  approvalArtifactId?: string;
  confirm?: boolean;
  actor: Actor;
}

export interface RejectL3OperationInput {
  projectId: string;
  pendingOperationId: string;
  reason: string;
  actor: Actor;
}

export interface DirectL3CommandInput extends VersionCommandInput {
  reason?: string;
}

export interface AdvanceToVersionCommandInput extends DirectL3CommandInput {
  fromVersionId?: string;
}

export interface AdvanceToVersionBlockedResult {
  status: "blocked";
  allowed: false;
  projectId: string;
  versionId: string;
  fromVersionId: string;
  blockers: GateBlocker[];
  dueDeferredIds: string[];
  blockedConstraintIds: string[];
}

export interface AdvanceToVersionProposalNextAction {
  action: "approve" | "reject";
  tool: "approve_l3_operation" | "reject_l3_operation";
  input: {
    projectId: string;
    pendingOperationId: string;
  };
  requiredInputs?: ["reason"];
}

export interface AdvanceToVersionConfirmationRequiredResult {
  status: "confirmation_required";
  allowed: true;
  projectId: string;
  versionId: string;
  fromVersionId: string;
  pendingOperationId: string;
  digest: string;
  humanReviewText: string;
  recommendedNextActions: AdvanceToVersionProposalNextAction[];
}

export type AdvanceToVersionResult =
  | AdvanceToVersionBlockedResult
  | AdvanceToVersionConfirmationRequiredResult;

export interface CreateVersionCommandInput {
  projectId: string;
  title: string;
  description?: string;
  reason?: string;
  actor: Actor;
}

export interface InsertVersionCommandInput extends CreateVersionCommandInput {
  afterVersionId?: string;
  beforeVersionId?: string;
}

export interface CreateChildVersionCommandInput extends InsertVersionCommandInput {
  parentVersionId: string;
}

export interface ReorderVersionsCommandInput extends DirectL3CommandInput {
  afterVersionId?: string;
  beforeVersionId?: string;
}

export interface GetVersionStructureInput {
  projectId: string;
  versionId?: string;
  residualAudit?: ResidualAuditInput;
}

export type TransitionVersionStepAction = "set_current_version" | "start_version";

export interface TransitionVersionResult {
  mode: RouteOperationWorkflowMode;
  status: "ready" | "blocked" | "noop" | "confirmation_required";
  projectId: string;
  versionId: string;
  currentVersionId: string | null;
  targetVersionState: Version["state"];
  targetIsCurrent: boolean;
  nextActionType: TransitionVersionStepAction | null;
  stepsRemaining: TransitionVersionStepAction[];
  blockers: GateBlocker[];
  dueDeferredIds: string[];
  blockedConstraintIds: string[];
  followUpRequired: boolean;
  proposalPersisted?: true;
  pendingOperationId?: string;
  operationDigest?: OperationDigest;
  humanReviewText?: string;
  proposedActionType?: TransitionVersionStepAction;
}

export interface CloseVersionWorkflowResult {
  mode: RouteOperationWorkflowMode;
  status: "ready" | "blocked" | "confirmation_required";
  projectId: string;
  versionId: string;
  blockers: GateBlocker[];
  unresolvedTodoIds: string[];
  unresolvedUndoIds: string[];
  unresolvedDeferredIds: string[];
  blockedConstraintIds: string[];
  proposalPersisted?: true;
  pendingOperationId?: string;
  operationDigest?: OperationDigest;
  humanReviewText?: string;
}

export interface ShutdownVersionWorkflowResult {
  mode: RouteOperationWorkflowMode;
  status: "ready" | "blocked" | "no_op" | "confirmation_required";
  projectId: string;
  versionId: string;
  forced: true;
  shutdownStateReason: string;
  blockers: GateBlocker[];
  ordinaryCloseGate: {
    allowed: boolean;
    blockers: GateBlocker[];
    unresolvedTodoIds: string[];
    unresolvedUndoIds: string[];
    unresolvedDeferredIds: string[];
    blockedConstraintIds: string[];
  };
  proposalPersisted?: true;
  pendingOperationId?: string;
  operationDigest?: OperationDigest;
  humanReviewText?: string;
}

export type VersionTransitionGuideStatus = "ready" | "blocked" | "noop" | "manual_review";

export type VersionTransitionGuideStepStatus =
  | "ready"
  | "blocked"
  | "not_needed"
  | "waiting";

export type VersionTransitionGuideActionType =
  | "review_pending_proposals"
  | "prepare_version"
  | "close_version"
  | "set_current_version"
  | "advance_to_version"
  | "start_version";

export interface VersionTransitionGuideVersionSummary {
  id: string;
  title: string;
  state: Version["state"];
  isCurrent: boolean;
}

export interface VersionTransitionGuideCloseGate {
  versionId: string;
  allowed: boolean;
  applicable: boolean;
  openTodoIds: string[];
  openUndoIds: string[];
  unresolvedDeferredIds: string[];
  blockedConstraintIds: string[];
  residualAuditProvided: boolean;
  residualAuditRequired: boolean;
  residualAuditSource:
    | "input"
    | "proposal_payload"
    | "committed_close_proposal"
    | "missing";
  residualAuditProposalId: string | null;
  blockers: GateBlocker[];
}

export interface VersionTransitionGuideStartGate {
  versionId: string;
  allowed: boolean;
  applicable: boolean;
  currentVersionId: string | null;
  openCurrentTodoIds: string[];
  dueUndoIds: string[];
  dueDeferredIds: string[];
  blockedConstraintIds: string[];
  selfReferentialUndoIds: string[];
  blockers: GateBlocker[];
}

export interface VersionTransitionGuideStep {
  stepId: string;
  label: string;
  status: VersionTransitionGuideStepStatus;
  recommendedTool: string;
  toolInput?: Record<string, unknown>;
  requiredInputs?: string[];
  createsL3Proposal: boolean;
  actionType: VersionTransitionGuideActionType | null;
  reason: string;
  blockerIds: string[];
}

export interface VersionTransitionGuide {
  project: {
    id: string;
    name: string;
    currentVersionId: string | null;
  };
  workflowMode: "read_only";
  status: VersionTransitionGuideStatus;
  fromVersion: VersionTransitionGuideVersionSummary;
  currentVersion: VersionTransitionGuideVersionSummary | null;
  targetVersion: VersionTransitionGuideVersionSummary;
  pendingProposalIds: string[];
  closeGate: VersionTransitionGuideCloseGate;
  startGate: VersionTransitionGuideStartGate;
  recommendedSteps: VersionTransitionGuideStep[];
  notes: string[];
}

export interface VersionStructureVersionSummary extends ContextCurrentVersionSummary {
  parentVersionId: string | null;
  previousVersionId: string | null;
  nextVersionId: string | null;
}

export interface VersionStructureUndoSummary extends ContextOpenUndoSummary {
  status: Undo["status"];
}

export interface VersionStructureLegalOperation {
  actionType:
    | "prepare_version"
    | "transition_version"
    | "mark_version_complete"
    | "close_version"
    | "shutdown_version"
    | "reopen_version"
    | "set_current_version"
    | "create_todo";
  allowed: boolean;
  summary: string;
  blockers: GateBlocker[];
  details?: Record<string, unknown>;
}

export interface VersionStructureView {
  project: {
    id: string;
    currentVersionId: string | null;
  };
  focusVersion: VersionStructureVersionSummary;
  currentVersion: ContextCurrentVersionSummary | null;
  parentVersion: ContextVersionSummary | null;
  siblings: ContextVersionSummary[];
  childVersions: ContextVersionSummary[];
  openTodos: ContextOpenTodoSummary[];
  openUndos: {
    owned: VersionStructureUndoSummary[];
    origin: VersionStructureUndoSummary[];
    preferredResolution: VersionStructureUndoSummary[];
  };
  legalOperations: VersionStructureLegalOperation[];
}

type TransitionWorkflowEvaluation = {
  status: "ready" | "blocked" | "noop";
  currentVersionId: string | null;
  targetVersion: Version;
  nextActionType: TransitionVersionStepAction | null;
  stepsRemaining: TransitionVersionStepAction[];
  blockers: GateBlocker[];
  dueDeferredIds: string[];
  blockedConstraintIds: string[];
};

type ContextVersionSummary = {
  id: string;
  title: string;
  state: Version["state"];
  stateReason: string | null;
  displayState: Version["state"] | "shutdown";
  displayLabel: string;
  isShutdown: boolean;
  order: number;
  isCurrent: boolean;
  isDiagnostic: boolean;
  updatedAt: string;
};

type ContextCurrentVersionSummary = ContextVersionSummary & {
  description: string;
};

type ContextOpenTodoSummary = {
  id: string;
  versionId: string;
  title: string;
  status: Todo["status"];
  description: string;
  updatedAt: string;
};

type ContextOpenUndoSummary = {
  id: string;
  versionId: string;
  originVersionId: string;
  preferredResolutionVersionId: string;
  carriedForwardAt: string | null;
  carriedForwardToVersionId: string | null;
  title: string;
  reason: string;
  description: string;
  updatedAt: string;
};

const DIAGNOSTIC_VERSION_PATTERNS = [/_probe/i, /\bprobe\b/i, /diagnostic/i, /test-only/i];

const cloneSnapshot = (snapshot: ProjectAggregateSnapshot): ProjectAggregateSnapshot =>
  structuredClone(snapshot);

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = sortKeys((value as Record<string, unknown>)[key]);
        return accumulator;
      }, {});
  }

  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(sortKeys(value));

const assertRouteOperationWorkflowMode = (
  mode: unknown
): RouteOperationWorkflowMode => {
  if (mode === undefined) {
    return "dry_run";
  }

  if (isRouteOperationWorkflowMode(mode)) {
    return mode;
  }

  throw new ApplicationError(
    "ROUTE_OPERATION_WORKFLOW_MODE_INVALID",
    "workflow mode 仅支持 dry_run 或 propose",
    {
      receivedMode: mode ?? null,
      allowedModes: ["dry_run", "propose"]
    }
  );
};

const makeHumanReviewText = (operation: PendingOperation): string => {
  const blockerCodes = operation.gateSnapshot.blockers.map((blocker) => blocker.code);
  const shutdownLines =
    operation.actionType === "shutdown_version" && operation.gateSnapshot.kind === "shutdown"
      ? [
          "forced-path: shutdown_version",
          `stateReason: ${operation.gateSnapshot.stateReason}`,
          operation.gateSnapshot.ordinaryCloseGate.blockers.length > 0
            ? `ordinaryCloseBlockers: ${operation.gateSnapshot.ordinaryCloseGate.blockers
                .map((blocker) => blocker.code)
                .join(", ")}`
            : "ordinaryCloseBlockers: none"
        ]
      : [];

  const reasonLines =
    operation.reasonSource === "system_default"
      ? [
          `system default reason: ${operation.reason}`,
          "human reason: not provided"
        ]
      : operation.reasonSource === "explicit_input"
        ? [`reason: ${operation.reason}`, "reason source: explicit input"]
        : [`reason: ${operation.reason}`, "reason source: legacy unspecified"];

  return [
    `RouteLedger proposal ${operation.id}`,
    `action: ${operation.actionType}`,
    `target: ${operation.targetId}`,
    `digest: ${operation.digest.value}`,
    ...reasonLines,
    blockerCodes.length > 0 ? `blockers: ${blockerCodes.join(", ")}` : "blockers: none",
    ...shutdownLines
  ].join("\n");
};

const replaceRecord = <T extends { id: string }>(records: T[], nextRecord: T): T[] =>
  records.map((record) => (record.id === nextRecord.id ? nextRecord : record));

const appendRecord = <T extends { id: string }>(records: T[], nextRecord: T): T[] =>
  records.some((record) => record.id === nextRecord.id)
    ? replaceRecord(records, nextRecord)
    : records.concat(nextRecord);

const summarizeVersion = (version: Version): ContextVersionSummary => ({
  ...describeVersionState(version),
  id: version.id,
  title: version.title,
  state: version.state,
  order: version.order,
  isCurrent: version.isCurrent,
  isDiagnostic: isDiagnosticVersion(version),
  updatedAt: version.updatedAt
});

const summarizeCurrentVersion = (version: Version): ContextCurrentVersionSummary => ({
  ...summarizeVersion(version),
  description: version.description
});

const summarizeOpenTodo = (todo: Todo): ContextOpenTodoSummary => ({
  id: todo.id,
  versionId: todo.versionId,
  title: todo.title,
  status: todo.status,
  description: todo.description,
  updatedAt: todo.updatedAt
});

const summarizeOpenUndo = (undo: Undo): ContextOpenUndoSummary => ({
  id: undo.id,
  versionId: undo.versionId,
  originVersionId: undo.originVersionId,
  preferredResolutionVersionId: undo.preferredResolutionVersionId,
  carriedForwardAt: undo.carriedForwardAt,
  carriedForwardToVersionId: undo.carriedForwardToVersionId,
  title: undo.title,
  reason: undo.reason,
  description: undo.description,
  updatedAt: undo.updatedAt
});

const summarizeVersionStructureVersion = (
  version: Version
): VersionStructureVersionSummary => ({
  ...summarizeCurrentVersion(version),
  parentVersionId: version.parentVersionId,
  previousVersionId: version.previousVersionId,
  nextVersionId: version.nextVersionId
});

const summarizeVersionStructureUndo = (undo: Undo): VersionStructureUndoSummary => ({
  ...summarizeOpenUndo(undo),
  status: undo.status
});

const summarizeGuideVersion = (
  version: Version
): VersionTransitionGuideVersionSummary => ({
  id: version.id,
  title: version.title,
  state: version.state,
  isCurrent: version.isCurrent
});

const isDiagnosticVersion = (version: Pick<Version, "title">): boolean =>
  DIAGNOSTIC_VERSION_PATTERNS.some((pattern) => pattern.test(version.title));

const collectBlockerIds = (blockers: GateBlocker[]): string[] => [
  ...new Set(blockers.flatMap((blocker) => blocker.recordIds))
];

const buildTransitionWorkflowEvaluation = (
  snapshot: ProjectAggregateSnapshot,
  versionId: string
): TransitionWorkflowEvaluation => {
  const targetVersion = requireVersion(snapshot, versionId);
  const currentVersionId = snapshot.project.currentVersionId;
  const currentVersion =
    currentVersionId === null ? null : requireVersion(snapshot, currentVersionId);
  const targetIsCurrent = currentVersionId === targetVersion.id;

  if (targetVersion.state === "running") {
    return {
      status: targetIsCurrent ? "noop" : "ready",
      currentVersionId,
      targetVersion,
      nextActionType: targetIsCurrent ? null : "set_current_version",
      stepsRemaining: targetIsCurrent ? [] : ["set_current_version"],
      blockers: [],
      dueDeferredIds: [],
      blockedConstraintIds: []
    };
  }

  if (targetVersion.state === "ready") {
    const gate = evaluateStartGate({
      targetVersion,
      currentVersionTodos:
        currentVersion === null
          ? []
          : snapshot.todos.filter(
              (todo) =>
                todo.versionId === currentVersion.id &&
                (todo.status === "wait" || todo.status === "running")
            ),
      dueUndos: snapshot.undos.filter((undo) => undo.status === "wait"),
      deferredItems: snapshot.deferredItems,
      constraints: snapshot.constraints,
      constraintChecks: []
    });

    return {
      status: gate.allowed ? "ready" : "blocked",
      currentVersionId,
      targetVersion,
      nextActionType: gate.allowed ? (targetIsCurrent ? "start_version" : "set_current_version") : null,
      stepsRemaining: gate.allowed
        ? targetIsCurrent
          ? ["start_version"]
          : ["set_current_version", "start_version"]
        : [],
      blockers: gate.blockers,
      dueDeferredIds: gate.dueDeferredIds,
      blockedConstraintIds: gate.blockedConstraintIds
    };
  }

  const stateSpecificBlockers: Record<Version["state"], GateBlocker[]> = {
    wait: [
      {
        code: "TARGET_VERSION_NOT_READY",
        message: "目标 version 仍处于 wait；需先 prepare_version 再 transition。",
        recordIds: [targetVersion.id]
      }
    ],
    ready: [],
    running: [],
    suspend: [
      {
        code: "TARGET_VERSION_SUSPENDED",
        message: "目标 version 处于 suspend；需先 reopen_version 再 transition。",
        recordIds: [targetVersion.id]
      }
    ],
    complete: [
      {
        code: "TARGET_VERSION_COMPLETE",
        message: "目标 version 已 complete；transition_version 不会把完成边界重新作为 active route。",
        recordIds: [targetVersion.id]
      }
    ],
    close: [
      {
        code: "TARGET_VERSION_CLOSED",
        message: "目标 version 已 close；需先 reopen_version 才能继续。",
        recordIds: [targetVersion.id]
      }
    ]
  };

  return {
    status: "blocked",
    currentVersionId,
    targetVersion,
    nextActionType: null,
    stepsRemaining: [],
    blockers: stateSpecificBlockers[targetVersion.state],
    dueDeferredIds: [],
    blockedConstraintIds: []
  };
};

const resolveCloseResidualAudit = (
  snapshot: ProjectAggregateSnapshot,
  versionId: string,
  input: ResidualAuditInput
) =>
  resolveResidualAudit(
    input,
    snapshot.pendingOperations
      .filter(
        (operation) =>
          operation.status === "pending" &&
          operation.actionType === "close_version" &&
          operation.targetId === versionId
      )
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((operation) => ({
        id: operation.id,
        residualAudit: operation.payload.residualAudit,
        residualAuditReviewed: operation.payload.residualAuditReviewed
      }))
  );

const buildVersionStructureLegalOperations = (
  snapshot: ProjectAggregateSnapshot,
  focusVersion: Version,
  residualAudit: ResidualAuditInput
): VersionStructureLegalOperation[] => {
  const transition = buildTransitionWorkflowEvaluation(snapshot, focusVersion.id);
  const resolvedAudit = resolveCloseResidualAudit(snapshot, focusVersion.id, residualAudit);
  const closeGate = evaluateCloseGate({
    version: focusVersion,
    todos: snapshot.todos.filter((todo) => todo.versionId === focusVersion.id),
    knownTodos: snapshot.todos,
    undos: snapshot.undos.filter(
      (undo) =>
        undo.versionId === focusVersion.id ||
        undo.originVersionId === focusVersion.id ||
        undo.preferredResolutionVersionId === focusVersion.id
    ),
    residualAudit: resolvedAudit.audit,
    knownVersions: snapshot.versions,
    deferredItems: snapshot.deferredItems,
    constraints: snapshot.constraints,
    constraintChecks: []
  });

  return [
    {
      actionType: "prepare_version",
      allowed: focusVersion.state === "wait",
      summary: "wait -> ready",
      blockers:
        focusVersion.state === "wait"
          ? []
          : [
              {
                code: "INVALID_VERSION_TRANSITION",
                message: "prepare_version 仅适用于 wait version。",
                recordIds: [focusVersion.id]
              }
            ]
    },
    {
      actionType: "transition_version",
      allowed: transition.status === "ready",
      summary:
        transition.status === "noop"
          ? "目标 version 已是 current 且处于 running。"
          : transition.stepsRemaining.length > 0
            ? `剩余步骤: ${transition.stepsRemaining.join(" -> ")}`
            : "当前不可 transition。",
      blockers: transition.blockers,
      details: {
        currentVersionId: transition.currentVersionId,
        targetState: transition.targetVersion.state,
        stepsRemaining: transition.stepsRemaining
      }
    },
    {
      actionType: "mark_version_complete",
      allowed: focusVersion.state === "running",
      summary: "running -> complete",
      blockers:
        focusVersion.state === "running"
          ? []
          : [
              {
                code: "INVALID_VERSION_TRANSITION",
                message: "mark_version_complete 仅适用于 running version。",
                recordIds: [focusVersion.id]
              }
            ]
    },
    {
      actionType: "close_version",
      allowed: closeGate.allowed,
      summary: "complete -> close，且需要 residual audit 与所有 open item 收口。",
      blockers: closeGate.blockers,
      details: {
        unresolvedTodoIds: closeGate.unresolvedTodoIds,
        unresolvedUndoIds: closeGate.unresolvedUndoIds,
        unresolvedDeferredIds: closeGate.unresolvedDeferredIds,
        blockedConstraintIds: closeGate.blockedConstraintIds
      }
    },
    {
      actionType: "shutdown_version",
      allowed: focusVersion.state !== "close",
      summary:
        "Forced path: emergency shutdown closes the version even if ordinary close blockers still exist.",
      blockers:
        focusVersion.state !== "close"
          ? []
          : [
              {
                code: "VERSION_ALREADY_CLOSED",
                message: "已 close 的 version 不能再次执行 shutdown_version。",
                recordIds: [focusVersion.id]
              }
            ],
      details: {
        forced: true,
        stateReasonPrefix: "shutdown:",
        ordinaryCloseGate: {
          allowed: closeGate.allowed,
          unresolvedTodoIds: closeGate.unresolvedTodoIds,
          unresolvedUndoIds: closeGate.unresolvedUndoIds,
          unresolvedDeferredIds: closeGate.unresolvedDeferredIds,
          blockedConstraintIds: closeGate.blockedConstraintIds,
          blockerCodes: closeGate.blockers.map((blocker) => blocker.code)
        }
      }
    },
    {
      actionType: "reopen_version",
      allowed: focusVersion.state === "close" || focusVersion.state === "suspend",
      summary: "close|suspend -> ready",
      blockers:
        focusVersion.state === "close" || focusVersion.state === "suspend"
          ? []
          : [
              {
                code: "INVALID_VERSION_TRANSITION",
                message: "reopen_version 仅适用于 close 或 suspend version。",
                recordIds: [focusVersion.id]
              }
            ]
    },
    {
      actionType: "set_current_version",
      allowed: !focusVersion.isCurrent,
      summary: "切换 current 指针；若旧 current 处于 running，会自动 suspend 旧 current。",
      blockers:
        focusVersion.isCurrent
          ? [
              {
                code: "TARGET_ALREADY_CURRENT",
                message: "目标 version 已是 current。",
                recordIds: [focusVersion.id]
              }
            ]
          : []
    },
    {
      actionType: "create_todo",
      allowed: true,
      summary: "为当前 version 补充待办。",
      blockers: []
    }
  ];
};

export const buildVersionTransitionGuide = (
  snapshot: ProjectAggregateSnapshot,
  input: GetVersionTransitionGuideInput
): VersionTransitionGuide => {
  const pendingProposalIds = snapshot.pendingOperations
    .filter((operation) => operation.status === "pending")
    .map((operation) => operation.id);
  const notes = [
    "Read-only guide only. It never creates pending proposals; execute the listed existing tools step by step."
  ];
  const currentVersion =
    snapshot.project.currentVersionId === null
      ? null
      : requireVersion(snapshot, snapshot.project.currentVersionId);
  const resolvedFromVersionId = input.fromVersionId ?? currentVersion?.id;

  if (resolvedFromVersionId === undefined) {
    throw new ApplicationError("VERSION_NOT_FOUND", "project 当前没有 current version，且未提供 fromVersionId", {
      projectId: input.projectId
    });
  }

  const fromVersion = requireVersion(snapshot, resolvedFromVersionId);
  const targetVersion = requireVersion(snapshot, input.targetVersionId);
  const currentVersionOpenTodos =
    currentVersion === null
      ? []
      : snapshot.todos.filter(
          (todo) =>
            todo.versionId === currentVersion.id &&
            (todo.status === "wait" || todo.status === "running")
        );
  const dueUndos = snapshot.undos.filter((undo) => undo.status === "wait");
  const residualAudit = resolveCloseResidualAudit(
    snapshot,
    fromVersion.id,
    input.residualAudit
  );
  const closeGateEvaluation = evaluateCloseGate({
    version: fromVersion,
    todos: snapshot.todos.filter((todo) => todo.versionId === fromVersion.id),
    knownTodos: snapshot.todos,
    undos: snapshot.undos.filter(
      (undo) =>
        undo.versionId === fromVersion.id ||
        undo.originVersionId === fromVersion.id ||
        undo.preferredResolutionVersionId === fromVersion.id
    ),
    residualAudit: residualAudit.audit,
    knownVersions: snapshot.versions,
    deferredItems: snapshot.deferredItems,
    constraints: snapshot.constraints,
    constraintChecks: []
  });
  const startGateEvaluation =
    targetVersion.state === "running"
      ? {
          allowed: true,
          blockers: [],
          openTodoIds: currentVersionOpenTodos.map((todo) => todo.id),
          dueUndoIds: dueUndos
            .filter((undo) => undo.preferredResolutionVersionId === targetVersion.id)
            .map((undo) => undo.id),
          selfReferentialUndoIds: dueUndos
            .filter((undo) => isSelfReferentialUndoForVersion(undo, targetVersion.id))
            .map((undo) => undo.id),
          missingDecisionRefs: [],
          dueDeferredIds: snapshot.deferredItems
            .filter(
              (deferred) =>
                deferred.status === "pending" &&
                deferred.targetReviewVersionId === targetVersion.id
            )
            .map((deferred) => deferred.id),
          blockedConstraintIds: []
        }
      : evaluateStartGate({
          targetVersion,
          currentVersionTodos: currentVersionOpenTodos,
          dueUndos,
          deferredItems: snapshot.deferredItems,
          constraints: snapshot.constraints,
          constraintChecks: []
        });
  const closeGate: VersionTransitionGuideCloseGate = {
    versionId: fromVersion.id,
    allowed: fromVersion.state === "close" ? true : closeGateEvaluation.allowed,
    applicable: fromVersion.state !== "close",
    openTodoIds: closeGateEvaluation.unresolvedTodoIds,
    openUndoIds: closeGateEvaluation.unresolvedUndoIds,
    unresolvedDeferredIds: closeGateEvaluation.unresolvedDeferredIds,
    blockedConstraintIds: closeGateEvaluation.blockedConstraintIds,
    residualAuditProvided: residualAudit.audit !== null,
    residualAuditRequired: fromVersion.state !== "close",
    residualAuditSource: residualAudit.source,
    residualAuditProposalId: residualAudit.proposalId,
    blockers: fromVersion.state === "close" ? [] : closeGateEvaluation.blockers
  };
  const startGate: VersionTransitionGuideStartGate = {
    versionId: targetVersion.id,
    allowed:
      targetVersion.state === "running" && targetVersion.isCurrent
        ? true
        : startGateEvaluation.allowed,
    applicable: targetVersion.state !== "running",
    currentVersionId: currentVersion?.id ?? null,
    openCurrentTodoIds: startGateEvaluation.openTodoIds,
    dueUndoIds: startGateEvaluation.dueUndoIds,
    dueDeferredIds: startGateEvaluation.dueDeferredIds,
    blockedConstraintIds: startGateEvaluation.blockedConstraintIds,
    selfReferentialUndoIds: startGateEvaluation.selfReferentialUndoIds,
    blockers:
      targetVersion.state === "running" && targetVersion.isCurrent
        ? []
        : startGateEvaluation.blockers
  };
  const recommendedSteps: VersionTransitionGuideStep[] = [];

  const addStep = (step: VersionTransitionGuideStep): void => {
    recommendedSteps.push(step);
  };

  const buildGuide = (
    status: VersionTransitionGuideStatus,
    steps: VersionTransitionGuideStep[],
    guideCloseGate = closeGate,
    guideStartGate = startGate
  ): VersionTransitionGuide => ({
    project: {
      id: snapshot.project.id,
      name: snapshot.project.name,
      currentVersionId: snapshot.project.currentVersionId
    },
    workflowMode: "read_only",
    status,
    fromVersion: summarizeGuideVersion(fromVersion),
    currentVersion: currentVersion === null ? null : summarizeGuideVersion(currentVersion),
    targetVersion: summarizeGuideVersion(targetVersion),
    pendingProposalIds,
    closeGate: guideCloseGate,
    startGate: guideStartGate,
    recommendedSteps: steps,
    notes
  });

  const selfTargetIsCurrent =
    currentVersion?.id === fromVersion.id && fromVersion.id === targetVersion.id;

  if (pendingProposalIds.length > 0) {
    notes.push("Pending L3 proposals already exist. Resolve them first so the live route and approval chain stay unambiguous.");
    return buildGuide("manual_review", [
      {
        stepId: "review-pending-proposals",
        label: "Review pending L3 proposals",
        status: "ready",
        recommendedTool: "list_l3_proposals",
        createsL3Proposal: false,
        actionType: "review_pending_proposals",
        reason: "现有 pending proposal 会改变 live route，guide 不会替你裁决、复用或生成新的 proposal。",
        blockerIds: pendingProposalIds
      }
    ]);
  }

  if (selfTargetIsCurrent) {
    const selfCloseGate: VersionTransitionGuideCloseGate =
      fromVersion.state === "complete" || fromVersion.state === "close"
        ? closeGate
        : {
            ...closeGate,
            allowed: false,
            applicable: false,
            residualAuditRequired: false,
            blockers: []
          };
    const selfStartGate: VersionTransitionGuideStartGate =
      targetVersion.state === "ready"
        ? startGate
        : {
            ...startGate,
            allowed: targetVersion.state === "running",
            applicable: false,
            blockers: []
          };

    if (targetVersion.state === "wait") {
      return buildGuide(
        "ready",
        [
          {
            stepId: "prepare-current-version",
            label: "Prepare current version",
            status: "ready",
            recommendedTool: "prepare_version",
            createsL3Proposal: false,
            actionType: "prepare_version",
            reason: "current version 仍是 wait；先用 prepare_version 进入 ready，再重新读取 guide。",
            blockerIds: []
          }
        ],
        selfCloseGate,
        selfStartGate
      );
    }

    if (targetVersion.state === "running") {
      notes.push("fromVersion and targetVersion already identify the current running version; no route operation is needed.");
      return buildGuide("noop", [], selfCloseGate, selfStartGate);
    }

    if (targetVersion.state === "close") {
      notes.push("fromVersion and targetVersion already identify the current closed version; no route operation is needed.");
      return buildGuide("noop", [], selfCloseGate, selfStartGate);
    }

    if (targetVersion.state === "ready") {
      const startStatus: VersionTransitionGuideStepStatus = startGate.allowed
        ? "ready"
        : "blocked";
      const selfStartSteps: VersionTransitionGuideStep[] = [
        {
          stepId: "start-current-version",
          label: "Start current version",
          status: startStatus,
          recommendedTool: "preview_or_propose_version_transition",
          createsL3Proposal: true,
          actionType: "start_version",
          reason: startGate.allowed
            ? "current version 已 ready；用 preview_or_propose_version_transition 生成 start_version proposal。"
            : "current version start gate 仍有 blockers，preview_or_propose_version_transition 目前不会创建 proposal。",
          blockerIds: collectBlockerIds(startGate.blockers)
        },
        {
          stepId: "approve-start-current-proposal",
          label: "Approve start proposal",
          status: startStatus === "ready" ? "waiting" : "not_needed",
          recommendedTool: "approve_l3_operation",
          createsL3Proposal: false,
          actionType: "start_version",
          reason: "start_version proposal 创建后，再走现有 approve_l3_operation 审批链。",
          blockerIds: startStatus === "blocked" ? collectBlockerIds(startGate.blockers) : []
        },
        {
          stepId: "commit-start-current-proposal",
          label: "Commit start proposal",
          status: startStatus === "ready" ? "waiting" : "not_needed",
          recommendedTool: "commit_l3_operation",
          createsL3Proposal: false,
          actionType: "start_version",
          reason: "审批通过后，再提交 start_version proposal。",
          blockerIds: startStatus === "blocked" ? collectBlockerIds(startGate.blockers) : []
        }
      ];

      return buildGuide(
        startStatus === "ready" ? "ready" : "blocked",
        selfStartSteps,
        selfCloseGate,
        selfStartGate
      );
    }

    if (targetVersion.state === "complete") {
      const closeStatus: VersionTransitionGuideStepStatus = closeGate.allowed
        ? "ready"
        : "blocked";
      const selfCloseSteps: VersionTransitionGuideStep[] = [
        {
          stepId: "close-current-version",
          label: "Close current version boundary",
          status: closeStatus,
          recommendedTool: "preview_or_propose_version_close",
          createsL3Proposal: true,
          actionType: "close_version",
          reason: closeGate.allowed
            ? "current version 已满足 close gate；用 preview_or_propose_version_close 生成 close proposal。"
            : "current version close gate 仍未通过，需先处理 blockers 或补 residual audit。",
          blockerIds: collectBlockerIds(closeGate.blockers)
        },
        {
          stepId: "approve-close-current-proposal",
          label: "Approve close proposal",
          status: closeStatus === "ready" ? "waiting" : "not_needed",
          recommendedTool: "approve_l3_operation",
          createsL3Proposal: false,
          actionType: "close_version",
          reason: "preview_or_propose_version_close 创建 proposal 后，再走现有 approve_l3_operation 审批链。",
          blockerIds: closeStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
        },
        {
          stepId: "commit-close-current-proposal",
          label: "Commit close proposal",
          status: closeStatus === "ready" ? "waiting" : "not_needed",
          recommendedTool: "commit_l3_operation",
          createsL3Proposal: false,
          actionType: "close_version",
          reason: "拿到 approval artifact 后，再用 commit_l3_operation 落地 close。",
          blockerIds: closeStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
        }
      ];

      return buildGuide(
        closeStatus === "ready" ? "ready" : "blocked",
        selfCloseSteps,
        selfCloseGate,
        selfStartGate
      );
    }
  }

  const fromIsCurrent = currentVersion?.id === fromVersion.id;
  const manualTargetStates: Version["state"][] = ["suspend", "complete", "close"];
  const requiresManualReview =
    !fromIsCurrent ||
    manualTargetStates.includes(targetVersion.state);

  if (!fromIsCurrent) {
    notes.push(
      "fromVersion is not the current Version. Confirm the live route before continuing from the source to the target."
    );
  }

  if (manualTargetStates.includes(targetVersion.state)) {
    notes.push(
      `The target Version is in \`${targetVersion.state}\`, outside this guide's ordinary close -> start path.`
    );
  }

  if (startGate.selfReferentialUndoIds.length > 0) {
    notes.push(
      "Target start gate contains self-referential undo blockers. Treat them as controller judgment items instead of guessing whether they are rollback guardrails or delayed cleanup."
    );
  }

  const closeProposalStatus: VersionTransitionGuideStepStatus = requiresManualReview
    ? "waiting"
    : fromVersion.state === "close"
      ? "not_needed"
      : closeGate.allowed
        ? "ready"
        : "blocked";
  addStep({
    stepId: "close-from-version",
    label: "Close from version boundary",
    status: closeProposalStatus,
    recommendedTool: "preview_or_propose_version_close",
    createsL3Proposal: true,
    actionType: "close_version",
    reason:
      fromVersion.state === "close"
        ? "from version 已经 close，无需再次创建 close proposal。"
        : closeGate.allowed
          ? "from version 已满足 close gate，可先用 preview_or_propose_version_close 生成 close proposal。"
          : "from version close gate 仍未通过，需先处理 blockers 或补 residual audit。",
    blockerIds: collectBlockerIds(closeGate.blockers)
  });
  addStep({
    stepId: "approve-close-proposal",
    label: "Approve close proposal",
    status:
      closeProposalStatus === "ready" || closeProposalStatus === "waiting"
        ? "waiting"
        : "not_needed",
    recommendedTool: "approve_l3_operation",
    createsL3Proposal: false,
    actionType: "close_version",
    reason: "preview_or_propose_version_close 创建 proposal 后，再走现有 approve_l3_operation 审批链。",
    blockerIds: closeProposalStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
  });
  addStep({
    stepId: "commit-close-proposal",
    label: "Commit close proposal",
    status:
      closeProposalStatus === "ready" || closeProposalStatus === "waiting"
        ? "waiting"
        : "not_needed",
    recommendedTool: "commit_l3_operation",
    createsL3Proposal: false,
    actionType: "close_version",
    reason: "拿到 approval artifact 后，再用 commit_l3_operation 落地 close。",
    blockerIds: closeProposalStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
  });

  const canProceedPastClose =
    !requiresManualReview && (fromVersion.state === "close" || closeGate.allowed);
  const prepareTargetStatus: VersionTransitionGuideStepStatus =
    targetVersion.state === "wait"
      ? canProceedPastClose
        ? fromVersion.state === "close"
          ? "ready"
          : "waiting"
        : "waiting"
      : "not_needed";
  addStep({
    stepId: "prepare-target-version",
    label: "Prepare target version",
    status: prepareTargetStatus,
    recommendedTool: "prepare_version",
    createsL3Proposal: false,
    actionType: "prepare_version",
    reason:
      targetVersion.state === "wait"
        ? "target version 仍是 wait，需先 prepare_version 才能进入 ready/start 路径。"
        : "target version 不在 wait，无需 prepare。",
    blockerIds: closeProposalStatus === "blocked" ? collectBlockerIds(closeGate.blockers) : []
  });

  const transitionEvaluation =
    targetVersion.state === "wait" || manualTargetStates.includes(targetVersion.state)
      ? null
      : buildTransitionWorkflowEvaluation(snapshot, targetVersion.id);
  const transitionActionType =
    fromVersion.state === "close" &&
    targetVersion.state === "ready" &&
    fromVersion.nextVersionId === targetVersion.id
      ? "advance_to_version"
      : transitionEvaluation?.nextActionType ??
    (targetVersion.state === "ready"
      ? targetVersion.isCurrent
        ? "start_version"
        : "set_current_version"
      : targetVersion.state === "running" && !targetVersion.isCurrent
        ? "set_current_version"
        : targetVersion.state === "running"
          ? "start_version"
          : null);
  const transitionProposalStatus: VersionTransitionGuideStepStatus =
    !canProceedPastClose || requiresManualReview
      ? "waiting"
      : targetVersion.state === "wait"
        ? "waiting"
        : transitionEvaluation === null
          ? "blocked"
          : transitionEvaluation.status === "noop"
            ? "not_needed"
            : transitionEvaluation.status === "blocked"
              ? "blocked"
              : fromVersion.state === "close"
                ? "ready"
                : "waiting";
  const transitionBlockers =
    transitionEvaluation?.blockers ?? startGate.blockers;
  addStep({
    stepId: "transition-to-target",
    label:
      transitionActionType === "advance_to_version"
        ? "Advance to target version"
        : transitionActionType === "start_version"
        ? "Start target version"
        : "Set current to target version",
    status: transitionProposalStatus,
    recommendedTool:
      transitionActionType === "advance_to_version"
        ? "propose_version_advance"
        : "preview_or_propose_version_transition",
    toolInput:
      transitionActionType === "advance_to_version"
        ? {
            projectId: snapshot.project.id,
            fromVersionId: fromVersion.id,
            versionId: targetVersion.id
          }
        : {
            projectId: snapshot.project.id,
            versionId: targetVersion.id
          },
    requiredInputs: [],
    createsL3Proposal: true,
    actionType: transitionActionType,
    reason:
      transitionEvaluation?.status === "noop"
        ? "target version 已经是 current 且处于 running，本步无需执行。"
        : targetVersion.state === "wait"
          ? "target version 尚未 ready；先 prepare，再重新进入 preview_or_propose_version_transition。"
          : transitionEvaluation?.status === "blocked"
            ? "target start gate 仍有 blockers，preview_or_propose_version_transition 目前不会创建 proposal。"
            : transitionActionType === "advance_to_version"
              ? "from 边界已关闭；用 propose_version_advance 生成一次原子切换并启动的 proposal。"
              : transitionActionType === "start_version"
              ? "关闭 from 边界后，用 preview_or_propose_version_transition 生成 start_version proposal。"
              : "关闭 from 边界后，用 preview_or_propose_version_transition 先生成 set_current_version proposal。",
    blockerIds: collectBlockerIds(transitionBlockers)
  });
  addStep({
    stepId: "approve-transition-proposal",
    label: "Approve transition proposal",
    status:
      transitionProposalStatus === "ready" || transitionProposalStatus === "waiting"
        ? "waiting"
        : "not_needed",
    recommendedTool: "approve_l3_operation",
    createsL3Proposal: false,
    actionType: transitionActionType,
    reason: "preview_or_propose_version_transition 创建 proposal 后，再审批对应 L3 proposal。",
    blockerIds: transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
  });
  addStep({
    stepId: "commit-transition-proposal",
    label: "Commit transition proposal",
    status:
      transitionProposalStatus === "ready" || transitionProposalStatus === "waiting"
        ? "waiting"
        : "not_needed",
    recommendedTool: "commit_l3_operation",
    createsL3Proposal: false,
    actionType: transitionActionType,
    reason: "审批通过后，再提交对应的 transition proposal。",
    blockerIds: transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
  });

  const needsStartAfterSetCurrent =
    transitionEvaluation?.status === "ready" &&
    transitionEvaluation.nextActionType === "set_current_version" &&
    targetVersion.state === "ready";
  addStep({
    stepId: "start-target-after-switch",
    label: "Start target after current switch",
    status:
      needsStartAfterSetCurrent
        ? "waiting"
        : "not_needed",
    recommendedTool: "preview_or_propose_version_transition",
    createsL3Proposal: true,
    actionType: "start_version",
    reason: needsStartAfterSetCurrent
      ? "set_current_version 提交后，需要再次执行 preview_or_propose_version_transition 生成 start_version proposal。"
      : "当前路径不需要额外的二次 start proposal。",
    blockerIds:
      transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
  });
  addStep({
    stepId: "approve-start-after-switch",
    label: "Approve start proposal",
    status: needsStartAfterSetCurrent ? "waiting" : "not_needed",
    recommendedTool: "approve_l3_operation",
    createsL3Proposal: false,
    actionType: "start_version",
    reason: "二次 preview_or_propose_version_transition 创建 start proposal 后，再审批。",
    blockerIds:
      transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
  });
  addStep({
    stepId: "commit-start-after-switch",
    label: "Commit start proposal",
    status: needsStartAfterSetCurrent ? "waiting" : "not_needed",
    recommendedTool: "commit_l3_operation",
    createsL3Proposal: false,
    actionType: "start_version",
    reason: "审批通过后，再提交 start proposal。",
    blockerIds:
      transitionProposalStatus === "blocked" ? collectBlockerIds(transitionBlockers) : []
  });

  const status: VersionTransitionGuideStatus = requiresManualReview
    ? "manual_review"
    : fromVersion.id === targetVersion.id && targetVersion.isCurrent && targetVersion.state === "running"
      ? "noop"
      : closeProposalStatus === "blocked" || transitionProposalStatus === "blocked"
        ? "blocked"
        : recommendedSteps.some((step) => step.status === "ready")
          ? "ready"
          : "noop";

  return buildGuide(status, recommendedSteps);
};

const requireProject = async (
  storage: ProjectSnapshotReader,
  projectId: string
): Promise<ProjectAggregateSnapshot> => {
  const snapshot = await storage.loadProjectAggregate(projectId);

  if (snapshot === null) {
    throw new ApplicationError("PROJECT_NOT_FOUND", "project 不存在", {
      projectId
    });
  }

  if (snapshot.project.id !== projectId) {
    throw new ApplicationError(
      "PROJECT_OWNERSHIP_MISMATCH",
      "storage 返回的 project 与请求 project 不一致",
      {
        projectId,
        actualProjectId: snapshot.project.id
      }
    );
  }

  return cloneSnapshot(snapshot);
};

const requireVersion = (snapshot: ProjectAggregateSnapshot, versionId: string): Version => {
  const version = snapshot.versions.find((item) => item.id === versionId);

  if (version === undefined) {
    throw new ApplicationError("VERSION_NOT_FOUND", "version 不存在", {
      projectId: snapshot.project.id,
      versionId
    });
  }

  if (version.projectId !== snapshot.project.id) {
    throw new ApplicationError("VERSION_OWNERSHIP_MISMATCH", "version 不属于当前 project", {
      projectId: snapshot.project.id,
      versionId,
      actualProjectId: version.projectId
    });
  }

  return version;
};

const requireTodo = (snapshot: ProjectAggregateSnapshot, todoId: string): Todo => {
  const todo = snapshot.todos.find((item) => item.id === todoId);

  if (todo === undefined) {
    throw new ApplicationError("TODO_NOT_FOUND", "todo 不存在", {
      projectId: snapshot.project.id,
      todoId
    });
  }

  if (todo.projectId !== snapshot.project.id) {
    throw new ApplicationError("TODO_OWNERSHIP_MISMATCH", "todo 不属于当前 project", {
      projectId: snapshot.project.id,
      todoId,
      actualProjectId: todo.projectId
    });
  }

  return todo;
};

const requireWorkItem = (snapshot: ProjectAggregateSnapshot, workItemId: string): WorkItem => {
  const workItem = snapshot.workItems.find((item) => item.id === workItemId);

  if (workItem === undefined) {
    throw new ApplicationError("WORK_ITEM_NOT_FOUND", "work_item 不存在", {
      projectId: snapshot.project.id,
      workItemId
    });
  }

  if (workItem.projectId !== snapshot.project.id) {
    throw new ApplicationError(
      "WORK_ITEM_OWNERSHIP_MISMATCH",
      "work_item 不属于当前 project",
      {
        projectId: snapshot.project.id,
        workItemId,
        actualProjectId: workItem.projectId
      }
    );
  }

  return workItem;
};

const requireDeferred = (
  snapshot: ProjectAggregateSnapshot,
  deferredId: string
): DeferredItem => {
  const deferred = snapshot.deferredItems.find((item) => item.id === deferredId);

  if (deferred === undefined) {
    throw new ApplicationError("DEFERRED_NOT_FOUND", "deferred item 不存在", {
      projectId: snapshot.project.id,
      deferredId
    });
  }

  if (deferred.projectId !== snapshot.project.id) {
    throw new ApplicationError(
      "DEFERRED_OWNERSHIP_MISMATCH",
      "deferred item 不属于当前 project",
      {
        projectId: snapshot.project.id,
        deferredId,
        actualProjectId: deferred.projectId
      }
    );
  }

  return deferred;
};

const requireConstraint = (
  snapshot: ProjectAggregateSnapshot,
  constraintId: string
): Constraint => {
  const constraint = snapshot.constraints.find((item) => item.id === constraintId);

  if (constraint === undefined) {
    throw new ApplicationError("CONSTRAINT_NOT_FOUND", "constraint 不存在", {
      projectId: snapshot.project.id,
      constraintId
    });
  }

  if (constraint.projectId !== snapshot.project.id) {
    throw new ApplicationError(
      "CONSTRAINT_OWNERSHIP_MISMATCH",
      "constraint 不属于当前 project",
      {
        projectId: snapshot.project.id,
        constraintId,
        actualProjectId: constraint.projectId
      }
    );
  }

  return constraint;
};

const requireDeferredActiveWorkItem = (
  snapshot: ProjectAggregateSnapshot,
  deferred: DeferredItem
): WorkItem => {
  const workItem = requireWorkItem(snapshot, deferred.workItemId);

  if (
    workItem.status !== "active" ||
    workItem.activeRecordType !== "deferred" ||
    workItem.activeRecordId !== deferred.id
  ) {
    throw new ApplicationError(
      "INVALID_WORK_ITEM_ACTIVE",
      "WorkItem active 指针与 Deferred 不一致",
      {
        projectId: snapshot.project.id,
        deferredId: deferred.id,
        workItemId: workItem.id,
        status: workItem.status,
        activeRecordType: workItem.activeRecordType,
        activeRecordId: workItem.activeRecordId
      }
    );
  }

  return workItem;
};

const buildStartGateSnapshot = (
  result: StartGateResult,
  evaluatedAt: string
): StartGateSnapshot => ({
  kind: "start",
  evaluatedAt,
  allowed: result.allowed,
  blockers: result.blockers,
  openTodoIds: result.openTodoIds,
  dueUndoIds: result.dueUndoIds,
  dueDeferredIds: result.dueDeferredIds,
  missingDecisionRefs: result.missingDecisionRefs,
  blockedConstraintIds: result.blockedConstraintIds
});

const buildCloseGateSnapshot = (
  result: CloseGateResult,
  evaluatedAt: string,
  residualAudit: ResidualAuditInput
): CloseGateSnapshot => {
  const resolved = resolveResidualAudit(residualAudit);

  return {
    kind: "close",
    evaluatedAt,
    allowed: result.allowed,
    blockers: result.blockers,
    unresolvedTodoIds: result.unresolvedTodoIds,
    unresolvedUndoIds: result.unresolvedUndoIds,
    unresolvedDeferredIds: result.unresolvedDeferredIds,
    blockedConstraintIds: result.blockedConstraintIds,
    residualAudit: resolved.audit?.items ?? null,
    residualAuditReviewed: resolved.audit !== null
  };
};

const buildShutdownGateSnapshot = (
  result: {
    allowed: boolean;
    blockers: GateBlocker[];
    ordinaryCloseGate: CloseGateResult;
  },
  evaluatedAt: string,
  stateReason: string
): ShutdownGateSnapshot => ({
  kind: "shutdown",
  evaluatedAt,
  allowed: result.allowed,
  blockers: result.blockers,
  forced: true,
  stateReason,
  ordinaryCloseGate: {
    allowed: result.ordinaryCloseGate.allowed,
    blockers: result.ordinaryCloseGate.blockers,
    unresolvedTodoIds: result.ordinaryCloseGate.unresolvedTodoIds,
    unresolvedUndoIds: result.ordinaryCloseGate.unresolvedUndoIds,
    unresolvedDeferredIds: result.ordinaryCloseGate.unresolvedDeferredIds,
    blockedConstraintIds: result.ordinaryCloseGate.blockedConstraintIds
  }
});

const buildNoopGateSnapshot = (evaluatedAt: string): NoopGateSnapshot => ({
  kind: "none",
  evaluatedAt,
  allowed: true,
  blockers: []
});

const buildDigest = (
  projectId: string,
  actionType: L3ActionType,
  targetId: string,
  payload: PendingOperationPayload,
  gateSnapshot: GateSnapshot
): OperationDigest =>
  rebuildCanonicalL3ProposalDigest({ projectId, actionType, targetId, payload, gateSnapshot });

const buildOperationDescription = (
  snapshot: ProjectAggregateSnapshot,
  actionType: L3ActionType,
  targetId: string,
  payload: PendingOperationPayload,
  evaluatedAt: string
): L3ProposalSecurityDescription => {
  switch (actionType) {
    case "start_version": {
      const targetVersion = requireVersion(snapshot, targetId);
      const currentVersionTodos =
        snapshot.project.currentVersionId === null
          ? []
          : snapshot.todos.filter(
              (todo) =>
                todo.versionId === snapshot.project.currentVersionId &&
                (todo.status === "wait" || todo.status === "running")
            );
      const dueUndos = snapshot.undos.filter((undo) => undo.status === "wait");
      const gate = evaluateStartGate({
        targetVersion,
        currentVersionTodos,
        dueUndos,
        deferredItems: snapshot.deferredItems,
        constraints: snapshot.constraints,
        constraintChecks: []
      });
      const gateSnapshot = buildStartGateSnapshot(gate, evaluatedAt);

      return {
        actionType,
        targetId,
        payload,
        gateSnapshot,
        digest: buildDigest(snapshot.project.id, actionType, targetId, payload, gateSnapshot)
      };
    }
    case "advance_to_version": {
      const targetVersion = requireVersion(snapshot, targetId);
      const currentVersionId = snapshot.project.currentVersionId;

      if (currentVersionId === null) {
        throw new ApplicationError("ROUTE_EMPTY", "空路线不能执行 advance_to_version");
      }

      const currentVersion = requireVersion(snapshot, currentVersionId);
      const requestedFromVersionId = payload.fromVersionId ?? currentVersionId;
      const routeBlockers: GateBlocker[] = [];

      if (requestedFromVersionId !== currentVersionId) {
        routeBlockers.push({
          code: "CURRENT_VERSION_MISMATCH",
          message: "fromVersionId 必须匹配 live current Version。",
          recordIds: [requestedFromVersionId, currentVersionId]
        });
      }

      if (currentVersion.state !== "close") {
        routeBlockers.push({
          code: "CURRENT_VERSION_NOT_CLOSED",
          message: "advance_to_version 只允许从已 close 的 current Version 推进。",
          recordIds: [currentVersion.id]
        });
      }

      if (currentVersion.nextVersionId !== targetVersion.id) {
        routeBlockers.push({
          code: "TARGET_VERSION_NOT_NEXT",
          message: "目标 Version 必须是 current Version 的直接下一 sibling。",
          recordIds: [currentVersion.id, targetVersion.id]
        });
      }

      const gate = evaluateStartGate({
        targetVersion,
        currentVersionTodos: snapshot.todos.filter(
          (todo) =>
            todo.versionId === targetVersion.id &&
            (todo.status === "wait" || todo.status === "running")
        ),
        dueUndos: snapshot.undos.filter((undo) => undo.status === "wait"),
        deferredItems: snapshot.deferredItems,
        constraints: snapshot.constraints,
        constraintChecks: []
      });
      const gateSnapshot = buildStartGateSnapshot(
        {
          ...gate,
          allowed: gate.allowed && routeBlockers.length === 0,
          blockers: routeBlockers.concat(gate.blockers)
        },
        evaluatedAt
      );
      const normalizedPayload: PendingOperationPayload = {
        ...payload,
        fromVersionId: requestedFromVersionId
      };

      return {
        actionType,
        targetId,
        payload: normalizedPayload,
        gateSnapshot,
        digest: buildDigest(
          snapshot.project.id,
          actionType,
          targetId,
          normalizedPayload,
          gateSnapshot
        )
      };
    }
    case "close_version": {
      const version = requireVersion(snapshot, targetId);
      const payloadAudit: ResidualAuditInput =
        payload.residualAuditReviewed === true
          ? { status: "reviewed", items: payload.residualAudit ?? [] }
          : payload.residualAudit;
      const resolvedAudit = resolveCloseResidualAudit(
        snapshot,
        targetId,
        payloadAudit
      );
      const normalizedPayload: PendingOperationPayload =
        resolvedAudit.audit === null
          ? payload
          : {
              ...payload,
              residualAudit: resolvedAudit.audit.items,
              residualAuditReviewed: true
            };
      const gate = evaluateCloseGate({
        version,
        todos: snapshot.todos.filter((todo) => todo.versionId === version.id),
        knownTodos: snapshot.todos,
        undos: snapshot.undos.filter(
          (undo) =>
            undo.versionId === version.id ||
            undo.originVersionId === version.id ||
            undo.preferredResolutionVersionId === version.id
        ),
        residualAudit: resolvedAudit.audit,
        knownVersions: snapshot.versions,
        deferredItems: snapshot.deferredItems,
        constraints: snapshot.constraints,
        constraintChecks: []
      });
      const gateSnapshot = buildCloseGateSnapshot(gate, evaluatedAt, resolvedAudit.audit);

      return {
        actionType,
        targetId,
        payload: normalizedPayload,
        gateSnapshot,
        digest: buildDigest(
          snapshot.project.id,
          actionType,
          targetId,
          normalizedPayload,
          gateSnapshot
        )
      };
    }
    case "shutdown_version": {
      const version = requireVersion(snapshot, targetId);
      const shutdownReason = payload.shutdownReason;

      if (typeof shutdownReason !== "string" || shutdownReason.trim().length === 0) {
        throw new ApplicationError(
          "MISSING_REQUIRED_FIELD",
          "shutdown_version 需要 shutdownReason",
          {
            actionType,
            targetId
          }
        );
      }

      const payloadAudit: ResidualAuditInput =
        payload.residualAuditReviewed === true
          ? { status: "reviewed", items: payload.residualAudit ?? [] }
          : payload.residualAudit;
      const ordinaryCloseResidualAudit = resolveCloseResidualAudit(
        snapshot,
        targetId,
        payloadAudit
      );
      const ordinaryCloseGate = evaluateCloseGate({
        version,
        todos: snapshot.todos.filter((todo) => todo.versionId === version.id),
        knownTodos: snapshot.todos,
        undos: snapshot.undos.filter(
          (undo) =>
            undo.versionId === version.id ||
            undo.originVersionId === version.id ||
            undo.preferredResolutionVersionId === version.id
        ),
        residualAudit: ordinaryCloseResidualAudit.audit,
        knownVersions: snapshot.versions,
        deferredItems: snapshot.deferredItems,
        constraints: snapshot.constraints,
        constraintChecks: []
      });
      const blockers =
        version.state === "close"
          ? [
              {
                code: "VERSION_ALREADY_CLOSED",
                message: "已 close 的 version 不能再次执行 shutdown_version。",
                recordIds: [version.id]
              }
            ]
          : [];
      const gateSnapshot = buildShutdownGateSnapshot(
        {
          allowed: blockers.length === 0,
          blockers,
          ordinaryCloseGate
        },
        evaluatedAt,
        buildShutdownStateReason(shutdownReason)
      );

      const normalizedPayload = {
        ...payload,
        shutdownReason
      };

      return {
        actionType,
        targetId,
        payload: normalizedPayload,
        gateSnapshot,
        digest: buildDigest(
          snapshot.project.id,
          actionType,
          targetId,
          normalizedPayload,
          gateSnapshot
        )
      };
    }
    case "reopen_version":
    case "set_current_version": {
      requireVersion(snapshot, targetId);

      const gateSnapshot = buildNoopGateSnapshot(evaluatedAt);

      return {
        actionType,
        targetId,
        payload,
        gateSnapshot,
        digest: buildDigest(snapshot.project.id, actionType, targetId, payload, gateSnapshot)
      };
    }
    case "create_version":
    case "insert_version":
    case "create_child_version":
    case "reorder_versions": {
      if (actionType === "insert_version" && payload.batchNormalizedPlan !== undefined) {
        if (targetId !== snapshot.project.id) {
          throw new ApplicationError(
            "PROJECT_VERSION_MISMATCH",
            "batch_create_versions 的 targetId 必须指向 project.id",
            {
              projectId: snapshot.project.id,
              targetId
            }
          );
        }

        const evaluated = evaluateBatchCreateVersions(
          snapshot,
          {
            anchor: payload.batchAnchor,
            items: payload.batchItems ?? [],
            partialAllowed: false,
            previousCurrentPolicy: payload.batchPreviousCurrentPolicy,
            setCurrentTo: payload.batchSetCurrentTo ?? undefined
          },
          evaluatedAt,
          buildBatchSnapshotHash(snapshot)
        );

        if (evaluated.ok === false) {
          throw new ApplicationError(
            evaluated.code,
            "batch_create_versions payload 无法通过 live preflight",
            {
              issues: evaluated.issues,
              blockers: evaluated.blockers
            }
          );
        }

        const gateSnapshot = buildNoopGateSnapshot(evaluatedAt);

        return {
          actionType,
          targetId,
          payload: evaluated.payload,
          gateSnapshot,
          digest: buildDigest(
            snapshot.project.id,
            actionType,
            targetId,
            evaluated.payload,
            gateSnapshot
          )
        };
      }

      const normalizedPayload = normalizeVersionTreePayload({
        versions: snapshot.versions,
        actionType,
        targetId,
        payload
      });
      const effectivePayload =
        actionType === "create_version" && snapshot.versions.length === 0
          ? { ...normalizedPayload, setAsCurrent: true }
          : normalizedPayload;

      const gateSnapshot = buildNoopGateSnapshot(evaluatedAt);

      return {
        actionType,
        targetId,
        payload: effectivePayload,
        gateSnapshot,
        digest: buildDigest(
          snapshot.project.id,
          actionType,
          targetId,
          effectivePayload,
          gateSnapshot
        )
      };
    }
    default: {
      const exhaustiveActionType: never = actionType;
      throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "未支持的 L3 action", {
        actionType: exhaustiveActionType
      });
    }
  }
};

const createL3ProposalSecurityPort = (): L3ProposalSecurityPort => ({
  describe: (input) =>
    buildOperationDescription(
      input.snapshot,
      input.actionType,
      input.targetId,
      input.payload,
      input.evaluatedAt
    )
});

const buildCloseGateResult = (
  snapshot: ProjectAggregateSnapshot,
  versionId: string,
  residualAudit: ResidualAuditInput,
  evaluatedAt: string
): CloseGateResult => {
  const resolvedAudit = resolveCloseResidualAudit(snapshot, versionId, residualAudit);
  const description = buildOperationDescription(
    snapshot,
    "close_version",
    versionId,
    {
      residualAudit: resolvedAudit.audit?.items ?? null,
      residualAuditReviewed: resolvedAudit.audit !== null
    },
    evaluatedAt
  );

  return {
    allowed: description.gateSnapshot.allowed,
    blockers: description.gateSnapshot.blockers,
    unresolvedTodoIds:
      description.gateSnapshot.kind === "close"
        ? description.gateSnapshot.unresolvedTodoIds
        : [],
    unresolvedUndoIds:
      description.gateSnapshot.kind === "close"
        ? description.gateSnapshot.unresolvedUndoIds
        : [],
    unresolvedDeferredIds:
      description.gateSnapshot.kind === "close"
        ? description.gateSnapshot.unresolvedDeferredIds
        : [],
    blockedConstraintIds:
      description.gateSnapshot.kind === "close"
        ? description.gateSnapshot.blockedConstraintIds
        : []
  };
};

export class RouteLedgerService {
  private readonly storage: RouteLedgerStorage;

  private readonly deps: DomainDependencies;

  private readonly queryService: RouteLedgerVersionQueryUseCases;

  private readonly versionCommandService: VersionCommandUseCases;

  private readonly batchCreateVersionsUseCase: BatchCreateVersionsExecutor;

  private readonly l3ProposalReadService: L3ProposalReadService;

  private readonly l3ProposalWriteService: L3ProposalWriteUseCases;

  private readonly l3LegacyApprovalService: L3LegacyApprovalUseCases;

  private readonly l3ExactAuthorizationService: L3ExactAuthorizationUseCases;

  private readonly l3OperationCommitService: L3OperationCommitUseCases;

  private readonly documentSource: DocumentSourcePort | null;

  constructor(options: RouteLedgerServiceOptions) {
    this.storage = options.storage;
    this.deps = options.deps;
    this.queryService = options.queryService ?? new RouteLedgerQueryService({ storage: options.storage });
    this.versionCommandService =
      options.versionCommandService ??
      new VersionCommandService({ storage: options.storage, deps: options.deps });
    this.batchCreateVersionsUseCase =
      options.batchCreateVersionsUseCase ??
      new BatchCreateVersionsUseCase({
        storage: options.storage,
        deps: options.deps,
        buildDigestPreview: ({ snapshot, payload, evaluatedAt }) =>
          buildDigest(
            snapshot.project.id,
            "insert_version",
            snapshot.project.id,
            payload,
            buildNoopGateSnapshot(evaluatedAt)
          ),
        propose: (input) => this.proposeL3Operation(input)
      });
    this.l3ProposalReadService = new L3ProposalReadService({
      storage: options.storage,
      clock: options.deps.clock
    });
    const l3ProposalSecurityPort = createL3ProposalSecurityPort();
    this.l3ProposalWriteService = new L3ProposalWriteService({
      storage: options.storage,
      deps: options.deps,
      securityPort: l3ProposalSecurityPort
    });
    this.l3LegacyApprovalService = new L3LegacyApprovalService({
      storage: options.storage,
      deps: options.deps,
      trustedControlPlaneConfigured: options.l3Authorization !== undefined
    });
    const trustedControlPlane: TrustedL3AuthorizationControlPlane | null =
      options.l3Authorization === undefined
        ? null
        : {
            exactStore: options.l3Authorization.exactStore,
            routeledgerRootDigest: options.l3Authorization.routeledgerRootDigest,
            ...(options.l3Authorization.profileId === undefined
              ? {}
              : { profileId: options.l3Authorization.profileId }),
            ...(options.l3Authorization.modeEpoch === undefined
              ? {}
              : { modeEpoch: options.l3Authorization.modeEpoch }),
            ...(options.l3Authorization.profileDigest === undefined
              ? {}
              : { profileDigest: options.l3Authorization.profileDigest })
          };
    this.l3ExactAuthorizationService = new L3ExactAuthorizationService({
      storage: options.storage,
      deps: options.deps,
      controlPlane: trustedControlPlane
    });
    this.l3OperationCommitService = new L3OperationCommitService({
      storage: options.storage,
      deps: options.deps,
      securityPort: l3ProposalSecurityPort,
      controlPlane: trustedControlPlane,
      commitCoordinator:
        options.l3Authorization === undefined
          ? null
          : options.l3Authorization.commitCoordinator
    });
    this.documentSource = options.documentSource ?? null;
  }

  private async saveProjectAggregate(snapshot: ProjectAggregateSnapshot): Promise<void> {
    await persistProjectAggregate(this.storage, snapshot);
  }

  private async executeOrdinaryWrite<TResult extends object>(input: {
    projectId: string;
    commandName: OrdinaryWriteCommandName;
    idempotencyKey?: string;
    actor: Actor;
    commandPayload: Record<string, unknown>;
    mutate: (snapshot: ProjectAggregateSnapshot) => TResult;
  }): Promise<TResult & { idempotency?: IdempotencyResultMetadata }> {
    const snapshot = await requireProject(this.storage, input.projectId);
    const idempotencyKey = input.idempotencyKey?.trim();
    if (input.idempotencyKey !== undefined && idempotencyKey === "") {
      throw new ApplicationError(
        "MISSING_REQUIRED_FIELD",
        "idempotencyKey must be a non-empty string",
        { commandName: input.commandName }
      );
    }
    const inputDigest =
      idempotencyKey === undefined
        ? null
        : `sha256:${crypto
            .createHash("sha256")
            .update(
              stableStringify({
                actor: input.actor,
                commandName: input.commandName,
                commandPayload: input.commandPayload,
                projectId: input.projectId
              })
            )
            .digest("hex")}`;
    const findReceipt = (candidate: ProjectAggregateSnapshot) =>
      (candidate.ordinaryWriteReceipts ?? []).find(
        (receipt) =>
          receipt.commandName === input.commandName &&
          receipt.idempotencyKey === idempotencyKey
      );
    const replayReceipt = (receipt: OrdinaryWriteReceipt) => {
      if (receipt.inputDigest !== inputDigest) {
        throw new ApplicationError(
          "IDEMPOTENCY_KEY_REUSE_MISMATCH",
          `idempotencyKey is already bound to a different ${input.commandName} command`,
          {
            commandName: input.commandName,
            idempotencyKey,
            receiptId: receipt.id
          }
        );
      }
      return {
        ...(structuredClone(receipt.result) as TResult),
        idempotency: {
          protected: true as const,
          receiptId: receipt.id,
          replayed: true,
          resultScope: "original_commit" as const,
          originalCommittedAt: receipt.committedAt,
          currentStateRefreshed: false
        }
      };
    };

    const existingReceipt = findReceipt(snapshot);
    if (existingReceipt !== undefined) return replayReceipt(existingReceipt);

    const result = input.mutate(snapshot);
    let receipt: OrdinaryWriteReceipt | undefined;
    if (idempotencyKey !== undefined && inputDigest !== null) {
      receipt = {
        id: this.deps.idGenerator.nextId(),
        projectId: input.projectId,
        commandName: input.commandName,
        idempotencyKey,
        inputDigest,
        resultSchemaVersion: 1,
        result: structuredClone(result) as unknown as Record<string, unknown>,
        actor: input.actor,
        committedAt: this.deps.clock.now()
      };
      snapshot.ordinaryWriteReceipts = (snapshot.ordinaryWriteReceipts ?? []).concat(
        receipt
      );
    }

    try {
      await this.saveProjectAggregate(snapshot);
    } catch (error) {
      const errorCode =
        error !== null && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (receipt === undefined || errorCode !== "STALE_SNAPSHOT") throw error;
      const refreshed = await requireProject(this.storage, input.projectId);
      const committedReceipt = findReceipt(refreshed);
      if (committedReceipt === undefined) throw error;
      return replayReceipt(committedReceipt);
    }

    return receipt === undefined
      ? result
      : {
          ...result,
          idempotency: {
            protected: true,
            receiptId: receipt.id,
            replayed: false,
            resultScope: "original_commit",
            originalCommittedAt: receipt.committedAt,
            currentStateRefreshed: true
          }
        };
  }

  async initProject(input: InitProjectInput) {
    const created = createProject({
      name: input.name,
      description: input.description,
      contentLocale: input.contentLocale,
      firstVersion: input.firstVersion,
      actor: input.actor,
      deps: this.deps
    });
    const snapshot: ProjectAggregateSnapshot = {
      headRevision: null,
      project: created.project,
      versions: created.firstVersion === null ? [] : [created.firstVersion],
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: created.events,
      pendingOperations: [],
      approvalArtifacts: [],
      ordinaryWriteReceipts: []
    };

    if (created.firstVersion !== null) {
      for (const title of input.firstVersion?.initialTodos ?? []) {
        if (title.trim().length === 0) {
          throw new ApplicationError(
            "MISSING_REQUIRED_FIELD",
            "firstVersion.initialTodos 不允许包含空标题"
          );
        }

        const todoCreation = createTodoDomain({
          projectId: created.project.id,
          versionId: created.firstVersion.id,
          title: title.trim(),
          actor: input.actor,
          deps: this.deps
        });
        snapshot.workItems.push(todoCreation.workItem);
        snapshot.todos.push(todoCreation.todo);
        snapshot.events.push(...todoCreation.events);
      }
    }

    await this.saveProjectAggregate(snapshot);

    const documentation =
      this.documentSource === null
        ? undefined
        : await inspectEntryDocumentCoverage({
            documentSource: this.documentSource,
            contentLocale: created.project.settings.contentLocale ?? "en"
          });

    return {
      ...created,
      workItems: snapshot.workItems,
      todos: snapshot.todos,
      events: snapshot.events,
      ...(documentation === undefined ? {} : { documentation })
    };
  }

  async setProjectContentLocale(input: SetProjectContentLocaleCommandInput) {
    const snapshot = await requireProject(this.storage, input.projectId);
    const updated = setProjectContentLocaleDomain({
      project: snapshot.project,
      contentLocale: input.contentLocale,
      reason: input.reason,
      actor: input.actor,
      deps: this.deps
    });

    snapshot.project = updated.project;
    snapshot.events = snapshot.events.concat(updated.events);
    await this.saveProjectAggregate(snapshot);

    return updated;
  }

  async listVersions(projectId: string): Promise<Version[]> {
    return this.queryService.listVersions(projectId);
  }

  async listVersionsWindow(input: ListVersionsWindowInput) {
    return this.queryService.listVersionsWindow(input);
  }

  async prepareVersion(input: VersionCommandInput) {
    return this.versionCommandService.prepareVersion(input);
  }

  async markVersionComplete(input: VersionCommandInput) {
    return this.versionCommandService.markVersionComplete(input);
  }

  async createTodo(input: CreateTodoCommandInput): Promise<CreateTodoCommandResult> {
    return this.executeOrdinaryWrite({
      projectId: input.projectId,
      commandName: "create_todo",
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      commandPayload: {
        versionId: input.versionId,
        title: input.title,
        description: input.description ?? ""
      },
      mutate: (snapshot) => {
        requireVersion(snapshot, input.versionId);
        const created = createTodoDomain({
          projectId: input.projectId,
          versionId: input.versionId,
          title: input.title,
          description: input.description,
          actor: input.actor,
          deps: this.deps
        });
        snapshot.workItems = snapshot.workItems.concat(created.workItem);
        snapshot.todos = snapshot.todos.concat(created.todo);
        snapshot.events = snapshot.events.concat(created.events);
        return created;
      }
    });
  }

  async closeTodo(input: CloseTodoCommandInput) {
    return this.executeOrdinaryWrite({
      projectId: input.projectId,
      commandName: "close_todo",
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      commandPayload: {
        todoId: input.todoId,
        reason: input.reason,
        note: input.note
      },
      mutate: (snapshot) => {
        const todo = requireTodo(snapshot, input.todoId);
        const workItem = requireWorkItem(snapshot, todo.workItemId);
        const closed = closeTodoDomain({
          todo,
          workItem,
          reason: input.reason,
          note: input.note,
          actor: input.actor,
          deps: this.deps
        });
        snapshot.todos = replaceRecord(snapshot.todos, closed.todo);
        snapshot.workItems = replaceRecord(snapshot.workItems, closed.workItem);
        snapshot.events = snapshot.events.concat(closed.events);
        return closed;
      }
    });
  }

  async deferWork(
    input: DeferWorkCommandInput
  ): Promise<DeferWorkCommandResult> {
    return this.executeOrdinaryWrite({
      projectId: input.projectId,
      commandName: "defer_work",
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      commandPayload:
        input.mode === "new"
          ? {
              mode: input.mode,
              originVersionId: input.originVersionId,
              targetReviewVersionId: input.targetReviewVersionId,
              title: input.title,
              description: input.description,
              reason: input.reason,
              reviewTrigger: input.reviewTrigger
            }
          : {
              mode: input.mode,
              todoId: input.todoId,
              targetReviewVersionId: input.targetReviewVersionId,
              reason: input.reason,
              note: input.note,
              reviewTrigger: input.reviewTrigger
            },
      mutate: (snapshot) => {
        if (input.mode === "new") {
          const originVersionId =
            input.originVersionId ?? snapshot.project.currentVersionId;

          if (originVersionId === null) {
            throw new ApplicationError(
              "VERSION_NOT_FOUND",
              "new deferred work 需要 current 或 origin version",
              { projectId: input.projectId }
            );
          }

          const originVersion = requireVersion(snapshot, originVersionId);
          assertDeferredRouteTarget(
            originVersion,
            input.targetReviewVersionId,
            snapshot.versions
          );
          const deferred = deferWorkWorkflow({
            mode: "new",
            projectId: input.projectId,
            currentVersionId: originVersion.id,
            targetReviewVersionId: input.targetReviewVersionId,
            title: input.title,
            description: input.description,
            reason: input.reason,
            reviewTrigger: input.reviewTrigger,
            actor: input.actor,
            deps: this.deps
          });

          snapshot.workItems = appendRecord(snapshot.workItems, deferred.workItem);
          snapshot.deferredItems = appendRecord(snapshot.deferredItems, deferred.deferred);
          snapshot.events = snapshot.events.concat(deferred.events);
          return deferred;
        }

        const todo = requireTodo(snapshot, input.todoId);
        const workItem = requireWorkItem(snapshot, todo.workItemId);
        const originVersion = requireVersion(snapshot, todo.versionId);
        assertDeferredRouteTarget(
          originVersion,
          input.targetReviewVersionId,
          snapshot.versions
        );
        const deferred = deferWorkWorkflow({
          mode: "todo",
          resolvedRecords: { todo, workItem },
          targetReviewVersionId: input.targetReviewVersionId,
          reason: input.reason,
          note: input.note,
          reviewTrigger: input.reviewTrigger,
          actor: input.actor,
          deps: this.deps
        });

        if (deferred.mode !== "todo") {
          throw new ApplicationError(
            "ACTION_NOT_IMPLEMENTED",
            "todo defer workflow 返回了错误 mode"
          );
        }

        snapshot.todos = replaceRecord(snapshot.todos, deferred.todo);
        snapshot.workItems = replaceRecord(snapshot.workItems, deferred.workItem);
        snapshot.deferredItems = appendRecord(snapshot.deferredItems, deferred.deferred);
        snapshot.events = snapshot.events.concat(deferred.events);
        return deferred;
      }
    });
  }

  async reviewDeferred(
    input: ReviewDeferredCommandInput
  ): Promise<ReviewDeferredCommandResult> {
    return this.executeOrdinaryWrite({
      projectId: input.projectId,
      commandName: "review_deferred",
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      commandPayload:
        input.action === "activate"
          ? {
              action: input.action,
              deferredId: input.deferredId,
              targetVersionId: input.targetVersionId,
              reason: input.reason,
              note: input.note
            }
          : input.action === "defer_again"
            ? {
                action: input.action,
                deferredId: input.deferredId,
                targetReviewVersionId: input.targetReviewVersionId,
                reason: input.reason,
                note: input.note,
                reviewTrigger: input.reviewTrigger
              }
            : {
                action: input.action,
                deferredId: input.deferredId,
                outcome: input.outcome,
                reason: input.reason,
                note: input.note,
                decisionRef: input.decisionRef
              },
      mutate: (snapshot) => {
        const deferred = requireDeferred(snapshot, input.deferredId);
        const workItem = requireDeferredActiveWorkItem(snapshot, deferred);

        if (input.action === "activate") {
          if (input.targetVersionId !== deferred.targetReviewVersionId) {
            throw new ApplicationError(
              "DEFERRED_ACTIVATE_TARGET_MISMATCH",
              "activate 必须使用 Deferred 当前 target review Version；换目标请先 defer_again",
              {
                projectId: input.projectId,
                deferredId: deferred.id,
                expectedTargetVersionId: deferred.targetReviewVersionId,
                actualTargetVersionId: input.targetVersionId
              }
            );
          }

          const targetVersion = requireVersion(snapshot, input.targetVersionId);
          const reviewed = reviewDeferredWorkflow({
            action: "activate",
            resolvedRecords: { deferred, workItem },
            targetVersionId: targetVersion.id,
            reason: input.reason,
            note: input.note,
            actor: input.actor,
            deps: this.deps
          });

          if (reviewed.action !== "activate") {
            throw new ApplicationError(
              "ACTION_NOT_IMPLEMENTED",
              "activate deferred workflow 返回了错误 action"
            );
          }

          snapshot.deferredItems = replaceRecord(
            snapshot.deferredItems,
            reviewed.deferred
          );
          snapshot.workItems = replaceRecord(snapshot.workItems, reviewed.workItem);
          snapshot.todos = appendRecord(snapshot.todos, reviewed.todo);
          snapshot.events = snapshot.events.concat(reviewed.events);
          return reviewed;
        }

        if (input.action === "defer_again") {
          const currentReviewVersion = requireVersion(
            snapshot,
            deferred.targetReviewVersionId
          );
          assertDeferredRouteTarget(
            currentReviewVersion,
            input.targetReviewVersionId,
            snapshot.versions
          );
          const reviewed = reviewDeferredWorkflow({
            action: "defer_again",
            resolvedRecords: { deferred, workItem },
            targetReviewVersionId: input.targetReviewVersionId,
            reason: input.reason,
            note: input.note,
            reviewTrigger: input.reviewTrigger,
            actor: input.actor,
            deps: this.deps
          });

          snapshot.deferredItems = replaceRecord(
            snapshot.deferredItems,
            reviewed.deferred
          );
          snapshot.workItems = replaceRecord(snapshot.workItems, reviewed.workItem);
          snapshot.events = snapshot.events.concat(reviewed.events);
          return reviewed;
        }

        const reviewed = reviewDeferredWorkflow({
          action: "resolve",
          resolvedRecords: { deferred, workItem },
          outcome: input.outcome,
          reason: input.reason,
          note: input.note,
          decisionRef: input.decisionRef,
          actor: input.actor,
          deps: this.deps
        });

        snapshot.deferredItems = replaceRecord(
          snapshot.deferredItems,
          reviewed.deferred
        );
        snapshot.workItems = replaceRecord(snapshot.workItems, reviewed.workItem);
        snapshot.events = snapshot.events.concat(reviewed.events);
        return reviewed;
      }
    });
  }

  async recordConstraint(
    input: RecordConstraintCommandInput
  ): Promise<RecordConstraintCommandResult> {
    return this.executeOrdinaryWrite({
      projectId: input.projectId,
      commandName: "record_constraint",
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      commandPayload: {
        rule: input.rule,
        rationale: input.rationale,
        scope: input.scope
      },
      mutate: (snapshot) => {
        if (input.scope.type === "version") {
          requireVersion(snapshot, input.scope.versionId);
        }
        const recorded = recordConstraintWorkflow({
          projectId: input.projectId,
          rule: input.rule,
          rationale: input.rationale,
          scope: input.scope,
          actor: input.actor,
          deps: this.deps
        });
        snapshot.constraints = appendRecord(snapshot.constraints, recorded.constraint);
        snapshot.events = snapshot.events.concat(recorded.events);
        return recorded;
      }
    });
  }

  async retireConstraint(
    input: RetireConstraintCommandInput
  ): Promise<RetireConstraintCommandResult> {
    return this.executeOrdinaryWrite({
      projectId: input.projectId,
      commandName: "retire_constraint",
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      commandPayload: {
        constraintId: input.constraintId,
        reason: input.reason,
        note: input.note
      },
      mutate: (snapshot) => {
        const constraint = requireConstraint(snapshot, input.constraintId);
        const retired = retireRecordedConstraint({
          constraint,
          reason: input.reason,
          note: input.note,
          actor: input.actor,
          deps: this.deps
        });
        snapshot.constraints = replaceRecord(snapshot.constraints, retired.constraint);
        snapshot.events = snapshot.events.concat(retired.events);
        return retired;
      }
    });
  }

  async transitionVersion(input: TransitionVersionInput): Promise<TransitionVersionResult> {
    const mode = assertRouteOperationWorkflowMode(input.mode);
    const snapshot = await requireProject(this.storage, input.projectId);
    const evaluation = buildTransitionWorkflowEvaluation(snapshot, input.versionId);
    const baseResult: TransitionVersionResult = {
      mode,
      status: evaluation.status,
      projectId: input.projectId,
      versionId: input.versionId,
      currentVersionId: evaluation.currentVersionId,
      targetVersionState: evaluation.targetVersion.state,
      targetIsCurrent: evaluation.targetVersion.isCurrent,
      nextActionType: evaluation.nextActionType,
      stepsRemaining: evaluation.stepsRemaining,
      blockers: evaluation.blockers,
      dueDeferredIds: evaluation.dueDeferredIds,
      blockedConstraintIds: evaluation.blockedConstraintIds,
      followUpRequired: evaluation.stepsRemaining.length > 1
    };

    if (mode === "dry_run" || evaluation.status !== "ready" || evaluation.nextActionType === null) {
      return baseResult;
    }

    const proposal =
      evaluation.nextActionType === "set_current_version"
        ? await this.proposeL3Operation({
            projectId: input.projectId,
            actionType: "set_current_version",
            targetId: input.versionId,
            ...resolveProposalReason(
              input.reason,
              "transition version requested: set current first"
            ),
            payload: {
              currentVersionId: input.versionId
            },
            actor: input.actor
          })
        : await this.proposeL3Operation({
            projectId: input.projectId,
            actionType: "start_version",
            targetId: input.versionId,
            ...resolveProposalReason(
              input.reason,
              "transition version requested: start ready target"
            ),
            actor: input.actor
          });

    return {
      ...baseResult,
      status: "confirmation_required",
      proposalPersisted: true,
      pendingOperationId: proposal.id,
      operationDigest: proposal.digest,
      humanReviewText: makeHumanReviewText(proposal),
      proposedActionType: evaluation.nextActionType
    };
  }

  async closeVersionWorkflow(
    input: CloseVersionWorkflowInput
  ): Promise<CloseVersionWorkflowResult> {
    const mode = assertRouteOperationWorkflowMode(input.mode);
    const gate = await this.checkCloseGate(input);
    const baseResult: CloseVersionWorkflowResult = {
      mode,
      status: gate.allowed ? "ready" : "blocked",
      projectId: input.projectId,
      versionId: input.versionId,
      blockers: gate.blockers,
      unresolvedTodoIds: gate.unresolvedTodoIds,
      unresolvedUndoIds: gate.unresolvedUndoIds,
      unresolvedDeferredIds: gate.unresolvedDeferredIds,
      blockedConstraintIds: gate.blockedConstraintIds
    };

    if (mode === "dry_run" || !gate.allowed) {
      return baseResult;
    }

    const resolvedAudit = resolveCloseResidualAudit(
      await requireProject(this.storage, input.projectId),
      input.versionId,
      input.residualAudit
    );

    const proposal = await this.proposeL3Operation({
      projectId: input.projectId,
      actionType: "close_version",
      targetId: input.versionId,
      ...resolveProposalReason(input.reason, "close version requested"),
      payload: {
        residualAudit: resolvedAudit.audit?.items ?? null,
        residualAuditReviewed: resolvedAudit.audit !== null
      },
      actor: input.actor
    });

    return {
      ...baseResult,
      status: "confirmation_required",
      proposalPersisted: true,
      pendingOperationId: proposal.id,
      operationDigest: proposal.digest,
      humanReviewText: makeHumanReviewText(proposal)
    };
  }

  async shutdownVersionWorkflow(
    input: ShutdownVersionWorkflowInput
  ): Promise<ShutdownVersionWorkflowResult> {
    const mode = assertRouteOperationWorkflowMode(input.mode);
    const snapshot = await requireProject(this.storage, input.projectId);
    const version = requireVersion(snapshot, input.versionId);
    const description = buildOperationDescription(
      snapshot,
      "shutdown_version",
      input.versionId,
      {
        shutdownReason: input.shutdownReason
      },
      this.deps.clock.now()
    );

    if (description.gateSnapshot.kind !== "shutdown") {
      throw new ApplicationError(
        "ACTION_NOT_IMPLEMENTED",
        "shutdown_version 必须产出 shutdown gate snapshot"
      );
    }

    const baseResult: ShutdownVersionWorkflowResult = {
      mode,
      status: version.state === "close" ? "no_op" : description.gateSnapshot.allowed ? "ready" : "blocked",
      projectId: input.projectId,
      versionId: input.versionId,
      forced: true,
      shutdownStateReason: description.gateSnapshot.stateReason,
      blockers: description.gateSnapshot.blockers,
      ordinaryCloseGate: {
        allowed: description.gateSnapshot.ordinaryCloseGate.allowed,
        blockers: description.gateSnapshot.ordinaryCloseGate.blockers,
        unresolvedTodoIds: description.gateSnapshot.ordinaryCloseGate.unresolvedTodoIds,
        unresolvedUndoIds: description.gateSnapshot.ordinaryCloseGate.unresolvedUndoIds,
        unresolvedDeferredIds:
          description.gateSnapshot.ordinaryCloseGate.unresolvedDeferredIds,
        blockedConstraintIds:
          description.gateSnapshot.ordinaryCloseGate.blockedConstraintIds
      }
    };

    if (mode === "dry_run" || !description.gateSnapshot.allowed) {
      return baseResult;
    }

    const proposal = await this.proposeL3Operation({
      projectId: input.projectId,
      actionType: "shutdown_version",
      targetId: input.versionId,
      ...resolveProposalReason(
        input.reason,
        `emergency shutdown requested (${description.gateSnapshot.stateReason})`
      ),
      payload: {
        shutdownReason: input.shutdownReason
      },
      actor: input.actor
    });

    return {
      ...baseResult,
      status: "confirmation_required",
      proposalPersisted: true,
      pendingOperationId: proposal.id,
      operationDigest: proposal.digest,
      humanReviewText: makeHumanReviewText(proposal)
    };
  }

  async getVersionTransitionGuide(
    input: GetVersionTransitionGuideInput
  ): Promise<VersionTransitionGuide> {
    const snapshot = await requireProject(this.storage, input.projectId);

    return buildVersionTransitionGuide(snapshot, input);
  }

  async getVersionStructure(input: GetVersionStructureInput): Promise<VersionStructureView> {
    const snapshot = await requireProject(this.storage, input.projectId);
    return buildVersionStructureView(snapshot, input);
  }

  async checkStartGate(input: VersionCommandInput): Promise<StartGateResult> {
    const snapshot = await requireProject(this.storage, input.projectId);
    const targetVersion = requireVersion(snapshot, input.versionId);
    const targetVersionTodos = snapshot.todos.filter(
      (todo) =>
        todo.versionId === targetVersion.id &&
        (todo.status === "wait" || todo.status === "running")
    );
    const dueUndos = snapshot.undos.filter((undo) => undo.status === "wait");
    const gate = evaluateStartGate({
      targetVersion,
      currentVersionTodos: targetVersionTodos,
      dueUndos,
      deferredItems: snapshot.deferredItems,
      constraints: snapshot.constraints,
      constraintChecks: []
    });

    return {
      allowed: gate.allowed,
      blockers: gate.blockers,
      openTodoIds: gate.openTodoIds,
      dueUndoIds: gate.dueUndoIds,
      dueDeferredIds: gate.dueDeferredIds,
      selfReferentialUndoIds: gate.selfReferentialUndoIds,
      missingDecisionRefs: gate.missingDecisionRefs,
      blockedConstraintIds: gate.blockedConstraintIds
    };
  }

  async checkCloseGate(input: CloseVersionCommandInput): Promise<CloseGateResult> {
    const snapshot = await requireProject(this.storage, input.projectId);
    return buildCloseGateResult(
      snapshot,
      input.versionId,
      input.residualAudit,
      this.deps.clock.now()
    );
  }

  async summarizeVersionCloseout(
    input: SummarizeVersionCloseoutInput
  ): Promise<{ data: VersionCloseoutSummary; meta: Record<string, unknown> }> {
    return this.queryService.summarizeVersionCloseout(input);
  }

  async planVersionCloseout(
    input: PlanVersionCloseoutInput
  ): Promise<{ data: VersionCloseoutPlan; meta: Record<string, unknown> }> {
    return this.queryService.planVersionCloseout(input);
  }

  async batchCreateVersions(input: BatchCreateVersionsInput): Promise<BatchCreateVersionsResult> {
    return this.batchCreateVersionsUseCase.execute(input);
  }

  async proposeL3Operation(input: ProposeL3OperationInput): Promise<PendingOperation> {
    return this.l3ProposalWriteService.proposeL3Operation(input);
  }

  async listL3Proposals(projectId: string): Promise<PendingOperation[]> {
    return this.l3ProposalReadService.listL3Proposals(projectId);
  }

  async getL3Proposal(projectId: string, pendingOperationId: string): Promise<PendingOperation> {
    return this.l3ProposalReadService.getL3Proposal(projectId, pendingOperationId);
  }

  async getL3AuthorizationEvaluationContext(input: GetL3AuthorizationEvaluationContextInput) {
    return this.l3ProposalReadService.getL3AuthorizationEvaluationContext(input);
  }

  async recommendBalancedL3AuthorizationPolicy(
    input: RecommendBalancedL3AuthorizationPolicyInput
  ) {
    return this.l3ProposalReadService.recommendBalancedL3AuthorizationPolicy(input);
  }

  async approveL3Operation(input: ApproveL3OperationInput): Promise<ApprovalArtifact> {
    return this.l3LegacyApprovalService.approveL3Operation(input);
  }

  async authorizeL3Operation(input: AuthorizeL3OperationInput): Promise<ApprovalArtifact> {
    return this.l3ExactAuthorizationService.authorizeL3Operation(input);
  }
  async rejectL3Operation(input: RejectL3OperationInput): Promise<PendingOperation> {
    return this.l3LegacyApprovalService.rejectL3Operation(input);
  }

  async commitL3Operation(input: CommitL3OperationInput) {
    return this.l3OperationCommitService.commitL3Operation(input);
  }

  async startVersion(input: DirectL3CommandInput): Promise<never> {
    return this.requestConfirmation(
      input.projectId,
      "start_version",
      input.versionId,
      resolveProposalReason(input.reason, "start version requested"),
      input.actor
    );
  }

  async closeVersion(input: CloseVersionCommandInput): Promise<never> {
    const gate = await this.checkCloseGate(input);

    if (!gate.allowed) {
      throw new ApplicationError("CLOSE_GATE_FAILED", "close gate 校验失败", {
        projectId: input.projectId,
        versionId: input.versionId,
        blockers: gate.blockers,
        unresolvedTodoIds: gate.unresolvedTodoIds,
        unresolvedUndoIds: gate.unresolvedUndoIds,
        unresolvedDeferredIds: gate.unresolvedDeferredIds,
        blockedConstraintIds: gate.blockedConstraintIds
      });
    }

    const snapshot = await requireProject(this.storage, input.projectId);
    const resolvedAudit = resolveCloseResidualAudit(
      snapshot,
      input.versionId,
      input.residualAudit
    );
    return this.requestConfirmation(
      input.projectId,
      "close_version",
      input.versionId,
      resolveProposalReason(undefined, "close version requested"),
      input.actor,
      {
        residualAudit: resolvedAudit.audit?.items ?? null,
        residualAuditReviewed: resolvedAudit.audit !== null
      }
    );
  }

  async shutdownVersion(input: ShutdownVersionCommandInput): Promise<never> {
    return this.requestConfirmation(
      input.projectId,
      "shutdown_version",
      input.versionId,
      resolveProposalReason(
        input.reason,
        `emergency shutdown requested (${buildShutdownStateReason(input.shutdownReason)})`
      ),
      input.actor,
      {
        shutdownReason: input.shutdownReason
      }
    );
  }

  async reopenVersion(input: DirectL3CommandInput): Promise<never> {
    return this.requestConfirmation(
      input.projectId,
      "reopen_version",
      input.versionId,
      resolveProposalReason(input.reason, "reopen version requested"),
      input.actor
    );
  }

  async setCurrentVersion(input: DirectL3CommandInput): Promise<never> {
    return this.requestConfirmation(
      input.projectId,
      "set_current_version",
      input.versionId,
      resolveProposalReason(input.reason, "set current version requested"),
      input.actor,
      {
        currentVersionId: input.versionId
      }
    );
  }

  async advanceToVersion(
    input: AdvanceToVersionCommandInput
  ): Promise<AdvanceToVersionResult> {
    const snapshot = await requireProject(this.storage, input.projectId);
    const description = buildOperationDescription(
      snapshot,
      "advance_to_version",
      input.versionId,
      { fromVersionId: input.fromVersionId },
      this.deps.clock.now()
    );

    if (description.gateSnapshot.kind !== "start") {
      throw new ApplicationError(
        "ACTION_NOT_IMPLEMENTED",
        "advance_to_version 必须产出 start gate snapshot"
      );
    }

    if (!description.gateSnapshot.allowed) {
      return {
        status: "blocked",
        allowed: false,
        projectId: input.projectId,
        versionId: input.versionId,
        fromVersionId: description.payload.fromVersionId!,
        blockers: description.gateSnapshot.blockers,
        dueDeferredIds: description.gateSnapshot.dueDeferredIds,
        blockedConstraintIds: description.gateSnapshot.blockedConstraintIds
      };
    }

    const proposal = await this.proposeL3Operation({
      projectId: input.projectId,
      actionType: "advance_to_version",
      targetId: input.versionId,
      ...resolveProposalReason(input.reason, "advance to version requested"),
      actor: input.actor,
      payload: {
        fromVersionId: input.fromVersionId
      },
      requirePassingGate: true
    });
    const nextActionInput = {
      projectId: input.projectId,
      pendingOperationId: proposal.id
    };

    return {
      status: "confirmation_required",
      allowed: true,
      projectId: input.projectId,
      versionId: input.versionId,
      fromVersionId: description.payload.fromVersionId!,
      pendingOperationId: proposal.id,
      digest: proposal.digest.value,
      humanReviewText: makeHumanReviewText(proposal),
      recommendedNextActions: [
        {
          action: "approve",
          tool: "approve_l3_operation",
          input: nextActionInput
        },
        {
          action: "reject",
          tool: "reject_l3_operation",
          input: nextActionInput,
          requiredInputs: ["reason"]
        }
      ]
    };
  }

  async createVersion(input: CreateVersionCommandInput): Promise<never> {
    return this.requestConfirmation(
      input.projectId,
      "create_version",
      this.deps.idGenerator.nextId(),
      resolveProposalReason(input.reason, "create version requested"),
      input.actor,
      {
        title: input.title,
        description: input.description
      }
    );
  }

  async insertVersion(input: InsertVersionCommandInput): Promise<never> {
    return this.requestConfirmation(
      input.projectId,
      "insert_version",
      this.deps.idGenerator.nextId(),
      resolveProposalReason(input.reason, "insert version requested"),
      input.actor,
      {
        title: input.title,
        description: input.description,
        previousVersionId: input.afterVersionId ?? null,
        nextVersionId: input.beforeVersionId ?? null
      }
    );
  }

  async createChildVersion(input: CreateChildVersionCommandInput): Promise<never> {
    return this.requestConfirmation(
      input.projectId,
      "create_child_version",
      this.deps.idGenerator.nextId(),
      resolveProposalReason(input.reason, "create child version requested"),
      input.actor,
      {
        title: input.title,
        description: input.description,
        parentVersionId: input.parentVersionId,
        previousVersionId: input.afterVersionId ?? null,
        nextVersionId: input.beforeVersionId ?? null
      }
    );
  }

  async reorderVersions(input: ReorderVersionsCommandInput): Promise<never> {
    return this.requestConfirmation(
      input.projectId,
      "reorder_versions",
      input.versionId,
      resolveProposalReason(input.reason, "reorder versions requested"),
      input.actor,
      {
        previousVersionId: input.afterVersionId ?? null,
        nextVersionId: input.beforeVersionId ?? null
      }
    );
  }

  async checkDocDrift(input: CheckDocDriftInput): Promise<{ data: CheckDocDriftResult }> {
    if (this.documentSource === null) {
      throw new Error("checkDocDrift requires RouteLedgerServiceOptions.documentSource");
    }

    const snapshot = await requireProject(this.storage, input.projectId);
    const context = buildDerivedCurrentContextData(snapshot, {});
    return {
      data: await runDocDriftCheck({
        documentSource: this.documentSource,
        project: snapshot.project,
        contentLocale: snapshot.project.settings.contentLocale,
        context,
        input
      })
    };
  }

  async getCurrentContext(input: GetCurrentContextInput) {
    return this.queryService.getCurrentContext(input);
  }

  async getNextAction(input: GetCurrentContextInput) {
    return this.queryService.getNextAction(input);
  }
  private async requestConfirmation(
    projectId: string,
    actionType: L3ActionType,
    targetId: string,
    resolvedReason: ResolvedProposalReason,
    actor: Actor,
    payload: PendingOperationPayload = {},
    requirePassingGate = false
  ): Promise<never> {
    const proposal = await this.proposeL3Operation({
      projectId,
      actionType,
      targetId,
      ...resolvedReason,
      actor,
      payload,
      requirePassingGate
    });

    throw new ApplicationError(
      "CONFIRMATION_REQUIRED",
      "该 L3 操作需要 approval artifact",
      {
        pendingOperationId: proposal.id,
        actionType,
        targetId,
        digest: proposal.digest.value,
        proposal,
        humanReviewText: makeHumanReviewText(proposal)
      }
    );
  }

}
