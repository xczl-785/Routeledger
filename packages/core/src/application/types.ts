import type { Actor } from "../domain/actor.js";
import type {
  GateBlocker,
  ResidualAuditItem
} from "../services/gate-service.js";

export const L3_ACTION_TYPES = [
  "start_version",
  "close_version",
  "shutdown_version",
  "reopen_version",
  "set_current_version",
  "advance_to_version",
  "create_version",
  "insert_version",
  "create_child_version",
  "reorder_versions"
] as const;

export type L3ActionType = (typeof L3_ACTION_TYPES)[number];

export type PendingOperationStatus = "pending" | "committed" | "rejected";

export const PENDING_OPERATION_REASON_SOURCES = [
  "explicit_input",
  "system_default",
  "legacy_unspecified"
] as const;

export type PendingOperationReasonSource =
  (typeof PENDING_OPERATION_REASON_SOURCES)[number];

export type ApprovalArtifactStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "consumed";

export interface StartGateSnapshot {
  kind: "start";
  evaluatedAt: string;
  allowed: boolean;
  blockers: GateBlocker[];
  openTodoIds: string[];
  dueUndoIds: string[];
  dueDeferredIds: string[];
  missingDecisionRefs: string[];
  blockedConstraintIds: string[];
}

export interface CloseGateSnapshot {
  kind: "close";
  evaluatedAt: string;
  allowed: boolean;
  blockers: GateBlocker[];
  unresolvedTodoIds: string[];
  unresolvedUndoIds: string[];
  unresolvedDeferredIds: string[];
  blockedConstraintIds: string[];
  residualAudit: ResidualAuditItem[] | null;
  /** Absent on historical snapshots; true preserves a reviewed empty audit. */
  residualAuditReviewed?: boolean;
}

export interface ShutdownGateSnapshot {
  kind: "shutdown";
  evaluatedAt: string;
  allowed: boolean;
  blockers: GateBlocker[];
  forced: true;
  stateReason: string;
  ordinaryCloseGate: {
    allowed: boolean;
    blockers: GateBlocker[];
    unresolvedTodoIds: string[];
    unresolvedUndoIds: string[];
    unresolvedDeferredIds: string[];
    blockedConstraintIds: string[];
  };
}

export interface NoopGateSnapshot {
  kind: "none";
  evaluatedAt: string;
  allowed: true;
  blockers: [];
}

export type GateSnapshot =
  | StartGateSnapshot
  | CloseGateSnapshot
  | ShutdownGateSnapshot
  | NoopGateSnapshot;

export interface OperationDigest {
  algorithm: "sha256";
  value: string;
  payload: Record<string, unknown>;
}

export const BATCH_CREATE_VERSIONS_MODES = ["preflight", "propose"] as const;

export type BatchCreateVersionsMode = (typeof BATCH_CREATE_VERSIONS_MODES)[number];

export const isBatchCreateVersionsMode = (
  value: unknown
): value is BatchCreateVersionsMode =>
  typeof value === "string" &&
  BATCH_CREATE_VERSIONS_MODES.includes(value as BatchCreateVersionsMode);

export const BATCH_PREVIOUS_CURRENT_POLICIES = [
  "leave_as_is",
  "require_complete_or_close"
] as const;

export type BatchPreviousCurrentPolicy =
  (typeof BATCH_PREVIOUS_CURRENT_POLICIES)[number];

export const isBatchPreviousCurrentPolicy = (
  value: unknown
): value is BatchPreviousCurrentPolicy =>
  typeof value === "string" &&
  BATCH_PREVIOUS_CURRENT_POLICIES.includes(value as BatchPreviousCurrentPolicy);

export const ROUTE_OPERATION_WORKFLOW_MODES = ["dry_run", "propose"] as const;

export type RouteOperationWorkflowMode =
  (typeof ROUTE_OPERATION_WORKFLOW_MODES)[number];

export const isRouteOperationWorkflowMode = (
  value: unknown
): value is RouteOperationWorkflowMode =>
  typeof value === "string" &&
  ROUTE_OPERATION_WORKFLOW_MODES.includes(value as RouteOperationWorkflowMode);

export interface BatchCreateVersionsAnchor {
  parentVersionId?: string | null;
  afterVersionId?: string | null;
  beforeVersionId?: string | null;
}

export interface BatchCreateVersionsItemInput {
  clientKey: string;
  title: string;
  description: string;
  initialTodos: string[];
}

export interface BatchCreateVersionsNormalizedItem {
  index: number;
  clientKey: string;
  previewVersionId: string;
  title: string;
  description: string;
  parentVersionId: string | null;
  previousRef: string | null;
  nextRef: string | null;
  initialTodos: string[];
}

export interface BatchCreateVersionsResolvedAnchors {
  parentVersionId: string | null;
  afterVersionId: string | null;
  beforeVersionId: string | null;
}

export interface BatchCreateVersionsIssue {
  index: number;
  clientKey: string;
  target: string;
  code: string;
  message: string;
  suggestion: string;
  details?: Record<string, unknown>;
}

export interface BatchCreateVersionsNotice {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PendingOperationPayload {
  currentVersionId?: string | null;
  fromVersionId?: string;
  residualAudit?: ResidualAuditItem[] | null;
  /** Explicit evidence that residualAudit was reviewed even when it is empty. */
  residualAuditReviewed?: boolean;
  shutdownReason?: string;
  title?: string;
  description?: string;
  parentVersionId?: string | null;
  previousVersionId?: string | null;
  nextVersionId?: string | null;
  siblingVersionIds?: string[];
  setAsCurrent?: boolean;
  batchItems?: BatchCreateVersionsItemInput[];
  batchAnchor?: BatchCreateVersionsAnchor;
  batchNormalizedPlan?: BatchCreateVersionsNormalizedItem[];
  batchResolvedAnchors?: BatchCreateVersionsResolvedAnchors;
  batchSetCurrentTo?: string | null;
  batchPreviousCurrentPolicy?: BatchPreviousCurrentPolicy;
  batchPreflightSnapshotHash?: string;
}

export interface PendingOperation {
  id: string;
  projectId: string;
  actionType: L3ActionType;
  targetId: string;
  status: PendingOperationStatus;
  reason: string;
  reasonSource: PendingOperationReasonSource;
  gateSnapshot: GateSnapshot;
  digest: OperationDigest;
  payload: PendingOperationPayload;
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  approvalArtifactId: string | null;
}

export interface ApprovalArtifact {
  id: string;
  projectId: string;
  pendingOperationId: string;
  actionType: L3ActionType;
  targetId: string;
  digest: OperationDigest;
  status: ApprovalArtifactStatus;
  approver: Actor;
  decisionRef: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  /** Absent only on legacy artifacts created before the trusted authorization control plane. */
  authorizationId?: string;
  /** Exact authorization root binding; absent on legacy audit-only artifacts. */
  routeledgerRootDigest?: string;
  approvalSource?: "user_interaction" | "delegated_policy" | "preauthorized" | "host_admission";
  policyId?: string | null;
  policyDigest?: string | null;
  profileId?: string;
  modeEpoch?: number;
  profileDigest?: string;
  hostKind?: string;
  clientId?: string | null;
}

export type CurrentContextRiskSeverity = "info" | "warning" | "blocking";

export interface CurrentContextStatusRisk {
  code: string;
  severity: CurrentContextRiskSeverity;
  summary: string;
  recordIds: string[];
}

export interface VersionWindowSummary {
  aroundVersionId: string | null;
  before: number;
  after: number;
  includeAllVersions: boolean;
  totalCount: number;
  includedCount: number;
  omittedBeforeCount: number;
  omittedAfterCount: number;
}

export type CurrentContextNextActionType =
  | "review_pending_proposal"
  | "review_deferred"
  | "review_residual_audit"
  | "work_todo"
  | "close_todo"
  | "close_version"
  | "prepare_version"
  | "create_version"
  | "advance_to_version"
  | "start_version"
  | "review_context"
  | "decision_required"
  | "none";

export interface CurrentContextNextActionChoice {
  actionType: "create_todo" | "mark_version_complete";
  when: string;
  recommendedTool: "create_todo" | "mark_version_complete";
  toolInput: Record<string, unknown>;
  requiredInputs: string[];
}

export interface CurrentContextRecommendedInput {
  field: string;
  contentRole: "human_review";
  localeSource: "project.contentLocale";
  guidance: string;
}

export interface CurrentContextNextAction {
  actionType: CurrentContextNextActionType;
  recommendedTool?: string;
  toolInput?: Record<string, unknown>;
  requiredInputs?: string[];
  recommendedInputs?: CurrentContextRecommendedInput[];
  summary: string;
  reason: string;
  targetId: string | null;
  requiresL3Approval: boolean;
  recordIds: string[];
  blockingRiskCodes: string[];
  choices?: CurrentContextNextActionChoice[];
}
