export type MissionControlScreen =
  | "ready"
  | "binding_error"
  | "json_error"
  | "current_closed";

export type MissionControlBindingStatus =
  | "bound"
  | "binding_error"
  | "uninitialized"
  | "unbound"
  | "invalid";

export type MissionControlStorageMode =
  | "json"
  | "json+sqlite"
  | "json+sqlite-degraded"
  | "uninitialized"
  | "binding_error"
  | "json_invalid";

export type MissionControlVersionState =
  | "wait"
  | "ready"
  | "running"
  | "suspend"
  | "complete"
  | "close";

export interface MissionControlBindingSummary {
  status: MissionControlBindingStatus;
  workspaceRoot: string | null;
  workspaceRootSource: string;
  workspaceRootConfidence: string;
  workspaceConfigPath: string | null;
  routeledgerRoot: string | null;
  dataRoot: string | null;
  routeledgerDir: string | null;
  diagnostics: string[];
}

export interface MissionControlCanonicalJsonSummary {
  status: "ready" | "missing" | "invalid";
  projectPath: string;
  issues: string[];
}

export interface MissionControlSqliteSummary {
  status: "absent" | "ready" | "degraded";
  dbPath: string;
  error: string | null;
}

export interface MissionControlStorageSummary {
  mode: MissionControlStorageMode;
  canonicalJson: MissionControlCanonicalJsonSummary;
  sqlite: MissionControlSqliteSummary;
}

export interface MissionControlIdentity {
  projectId: string;
  projectName: string;
  projectDescription: string;
  projectStatus: string;
  currentVersionId: string | null;
  currentVersionTitle: string | null;
  currentVersionState: MissionControlVersionState | null;
  currentVersionDisplayLabel: string | null;
  currentVersionStateReason: string | null;
  currentVersionOrder: number | null;
  versionCount: number;
  updatedAt: string;
}

export interface MissionControlRisk {
  code: string;
  severity: "info" | "warning" | "blocking";
  summary: string;
  recordIds: string[];
}

export interface MissionControlNextAction {
  actionType: string;
  summary: string;
  reason: string;
  targetId: string | null;
  requiresL3Approval: boolean;
  blockingRiskCodes: string[];
}

export interface MissionControlOverview {
  openTodoCount: number;
  pendingDeferredCount: number;
  dueDeferredCount: number;
  activeConstraintCount: number;
  pendingProposalCount: number;
  activeWorkItemCount: number;
  diagnosticVersionCount: number;
}

export interface MissionControlTodoItem {
  id: string;
  title: string;
  description: string;
  status: string;
  updatedAt: string;
}

export interface MissionControlDeferredItem {
  id: string;
  title: string;
  description: string;
  reason: string;
  status: string;
  reviewTrigger: string | null;
  targetReviewVersionId: string;
  targetReviewVersionTitle: string;
  isDue: boolean;
  updatedAt: string;
}

export interface MissionControlConstraintItem {
  id: string;
  rule: string;
  rationale: string;
  scope: "project" | "current_version";
  status: string;
  updatedAt: string;
}

export interface MissionControlLegacyUndoItem {
  id: string;
  title: string;
  reason: string;
  status: string;
  updatedAt: string;
}

export interface MissionControlLegacyAudit {
  openRecordCount: number;
  currentVersionBlockerCount: number;
  records: MissionControlLegacyUndoItem[];
}

export interface MissionControlRoadmapItem {
  id: string;
  title: string;
  order: number;
  state: MissionControlVersionState;
  displayLabel: string;
  isCurrent: boolean;
  isDiagnostic: boolean;
  updatedAt: string;
  parentVersionId: string | null;
  previousVersionId: string | null;
  nextVersionId: string | null;
  childCount: number;
  openTodoCount: number;
  pendingDeferredCount: number;
  activeConstraintCount: number;
}

export interface MissionControlCurrentVersion {
  id: string;
  title: string;
  description: string;
  state: MissionControlVersionState;
  displayLabel: string;
  stateReason: string | null;
  order: number;
  updatedAt: string;
  previousVersionTitle: string | null;
  nextVersionTitle: string | null;
  parentVersionTitle: string | null;
  todos: MissionControlTodoItem[];
  deferred: MissionControlDeferredItem[];
  constraints: MissionControlConstraintItem[];
}

export interface MissionControlTreeNode {
  id: string;
  title: string;
  description: string;
  state: MissionControlVersionState;
  displayLabel: string;
  isCurrent: boolean;
  order: number;
}

export interface MissionControlVersionTree {
  focus: MissionControlTreeNode;
  parent: MissionControlTreeNode | null;
  siblings: MissionControlTreeNode[];
  children: MissionControlTreeNode[];
}

export interface MissionControlProposal {
  id: string;
  actionType: string;
  targetId: string;
  status: string;
  reason: string;
  createdAt: string;
  gateKind: string;
  gateAllowed: boolean;
  blockerCount: number;
  approvalArtifactId: string | null;
}

export interface MissionControlApprovalArtifact {
  id: string;
  pendingOperationId: string;
  actionType: string;
  targetId: string;
  status: string;
  approverName: string;
  decisionRef: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface MissionControlAuditEvent {
  id: string;
  targetType: string;
  targetId: string;
  eventType: string;
  fromState: string | null;
  toState: string | null;
  actorName: string;
  createdAt: string;
  note: string | null;
}

export interface MissionControlResponse {
  generatedAt: string;
  screen: MissionControlScreen;
  message: string;
  binding: MissionControlBindingSummary;
  storage: MissionControlStorageSummary;
  identity: MissionControlIdentity | null;
  overview: MissionControlOverview | null;
  roadmap: MissionControlRoadmapItem[];
  currentVersion: MissionControlCurrentVersion | null;
  tree: MissionControlVersionTree | null;
  proposals: MissionControlProposal[];
  approvals: MissionControlApprovalArtifact[];
  auditTrail: MissionControlAuditEvent[];
  legacyAudit: MissionControlLegacyAudit;
  statusRisks: MissionControlRisk[];
  nextAction: MissionControlNextAction | null;
}
