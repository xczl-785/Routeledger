import path from "node:path";

import {
  buildVersionStructureView,
  RouteLedgerQueryService,
  type ApprovalArtifact,
  type PendingOperation,
  type ProjectAggregateSnapshot,
  type ProjectSnapshotReader,
  type TransitionEvent,
  type Undo,
  type Version
} from "@routeledger/core";
import { PROJECT_DOCUMENT_PATH, loadValidatedProjectAggregateFromJsonDirectory } from "@routeledger/json";

import type {
  MissionControlApprovalArtifact,
  MissionControlAuditEvent,
  MissionControlBindingSummary,
  MissionControlConstraintItem,
  MissionControlCurrentVersion,
  MissionControlDeferredItem,
  MissionControlLegacyUndoItem,
  MissionControlProposal,
  MissionControlResponse,
  MissionControlRoadmapItem,
  MissionControlScreen,
  MissionControlSqliteSummary,
  MissionControlStorageMode,
  MissionControlStorageSummary,
  MissionControlTreeNode,
  MissionControlVersionTree
} from "../shared/mission-control.js";

type LauncherBindingInput = {
  workspaceRoot: string;
  routeledgerRoot: string;
};

type CurrentContextData = {
  dueDeferredIds: string[];
  pendingL3Proposals: Array<{ id: string }>;
  statusRisks: MissionControlResponse["statusRisks"];
  nextAction: {
    actionType: string;
    summary: string;
    reason: string;
    targetId: string | null;
    requiresL3Approval: boolean;
    blockingRiskCodes: string[];
  } | null;
  versions: Array<{
    id: string;
    title: string;
    state: Version["state"];
    displayLabel: string;
    isCurrent: boolean;
    isDiagnostic: boolean;
    order: number;
    updatedAt: string;
  }>;
};

class ReadOnlySnapshotStorage implements ProjectSnapshotReader {
  constructor(private readonly snapshot: ProjectAggregateSnapshot) {}

  async loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null> {
    return this.snapshot.project.id === projectId ? this.snapshot : null;
  }

}

const isContainedWithin = (root: string, candidate: string): boolean => {
  const relativePath = path.relative(root, candidate);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const versionSort = (left: Version, right: Version): number => left.order - right.order;

const shutdownStateReasonPrefix = "shutdown:";

const isShutdownStateReason = (stateReason: string | null): boolean =>
  typeof stateReason === "string" && stateReason.startsWith(shutdownStateReasonPrefix);

const describeVersionState = (version: Pick<Version, "state" | "stateReason">) => {
  const isShutdown = version.state === "close" && isShutdownStateReason(version.stateReason);

  return {
    displayState: isShutdown ? "shutdown" : version.state,
    displayLabel: isShutdown ? "SHUTDOWN" : version.state.toUpperCase(),
    isShutdown,
    stateReason: version.stateReason
  };
};

const isUndoCarriedForwardAwayFromVersion = (
  undo: Pick<Undo, "versionId" | "originVersionId" | "carriedForwardAt" | "carriedForwardToVersionId">,
  versionId: string
): boolean =>
  undo.carriedForwardAt !== null &&
  undo.carriedForwardToVersionId !== null &&
  undo.carriedForwardToVersionId !== versionId &&
  (undo.versionId === versionId || undo.originVersionId === versionId);

const isUndoBlockingCloseForVersion = (
  undo: Pick<
    Undo,
    "status" | "versionId" | "originVersionId" | "carriedForwardAt" | "carriedForwardToVersionId"
  >,
  versionId: string
): boolean =>
  undo.status === "wait" && !isUndoCarriedForwardAwayFromVersion(undo, versionId);

const createBindingSummary = (input: LauncherBindingInput): MissionControlBindingSummary => {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const routeledgerRoot = path.resolve(input.routeledgerRoot);
  const routeledgerDir = path.join(routeledgerRoot, ".routeledger");
  const workspaceConfigPath = path.join(workspaceRoot, ".routeledger", "config.json");
  const diagnostics: string[] = [];
  let status: MissionControlBindingSummary["status"] = "bound";

  if (!isContainedWithin(workspaceRoot, routeledgerRoot)) {
    status = "invalid";
    diagnostics.push("routeledgerRoot 必须位于 workspaceRoot 内。");
  }

  return {
    status,
    workspaceRoot,
    workspaceRootSource: "explicit_arg",
    workspaceRootConfidence: "high",
    workspaceConfigPath,
    routeledgerRoot,
    dataRoot: routeledgerRoot,
    routeledgerDir,
    diagnostics
  };
};

const describeUnusedSqliteReadModel = (routeledgerRoot: string): MissionControlSqliteSummary => {
  const dbPath = path.join(routeledgerRoot, ".routeledger", "db", "routeledger.sqlite3");
  return { status: "absent", dbPath, error: null };
};

const buildStorageSummary = (options: {
  mode: MissionControlStorageMode;
  binding: MissionControlBindingSummary;
  canonicalStatus: MissionControlStorageSummary["canonicalJson"]["status"];
  canonicalIssues?: string[];
  sqlite: MissionControlSqliteSummary;
}): MissionControlStorageSummary => ({
  mode: options.mode,
  canonicalJson: {
    status: options.canonicalStatus,
    projectPath:
      options.binding.routeledgerRoot === null
        ? PROJECT_DOCUMENT_PATH
        : path.join(options.binding.routeledgerRoot, PROJECT_DOCUMENT_PATH),
    issues: options.canonicalIssues ?? []
  },
  sqlite: options.sqlite
});

const toProposalSummary = (proposal: PendingOperation): MissionControlProposal => ({
  id: proposal.id,
  actionType: proposal.actionType,
  targetId: proposal.targetId,
  status: proposal.status,
  reason: proposal.reason,
  createdAt: proposal.createdAt,
  gateKind: proposal.gateSnapshot.kind,
  gateAllowed: proposal.gateSnapshot.allowed,
  blockerCount: proposal.gateSnapshot.blockers.length,
  approvalArtifactId: proposal.approvalArtifactId
});

const toApprovalSummary = (approval: ApprovalArtifact): MissionControlApprovalArtifact => ({
  id: approval.id,
  pendingOperationId: approval.pendingOperationId,
  actionType: approval.actionType,
  targetId: approval.targetId,
  status: approval.status,
  approverName: approval.approver.displayName ?? approval.approver.id,
  decisionRef: approval.decisionRef,
  createdAt: approval.createdAt,
  expiresAt: approval.expiresAt,
  consumedAt: approval.consumedAt
});

const toAuditEventSummary = (event: TransitionEvent): MissionControlAuditEvent => ({
  id: event.id,
  targetType: event.targetType,
  targetId: event.targetId,
  eventType: event.eventType,
  fromState: event.fromState,
  toState: event.toState,
  actorName: event.actorDisplayName ?? event.actorId,
  createdAt: event.createdAt,
  note: event.note
});

const dedupeLegacyUndos = (undos: Undo[]): MissionControlLegacyUndoItem[] => {
  const seen = new Set<string>();
  const ordered = undos.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return ordered.flatMap((undo) => {
    if (seen.has(undo.id)) {
      return [];
    }

    seen.add(undo.id);
    return [
      {
        id: undo.id,
        title: undo.title,
        reason: undo.reason,
        status: undo.status,
        updatedAt: undo.updatedAt
      }
    ];
  });
};

const getBlockingUndosForVersion = (
  undos: Undo[],
  versionId: string
): MissionControlLegacyUndoItem[] =>
  dedupeLegacyUndos(
    undos.filter(
      (undo) =>
        (undo.versionId === versionId ||
          undo.originVersionId === versionId ||
          undo.preferredResolutionVersionId === versionId) &&
        isUndoBlockingCloseForVersion(undo, versionId)
    )
  );

const summarizeTreeNode = (
  version:
    | {
        id: string;
        title: string;
        description?: string;
        state: Version["state"];
        displayLabel: string;
        isCurrent: boolean;
        order: number;
      }
    | null
): MissionControlTreeNode | null => {
  if (version === null) {
    return null;
  }

  return {
    id: version.id,
    title: version.title,
    description: version.description ?? "",
    state: version.state,
    displayLabel: version.displayLabel,
    isCurrent: version.isCurrent,
    order: version.order
  };
};

export const buildMissionControlViewModel = async (
  snapshot: ProjectAggregateSnapshot,
  binding: MissionControlBindingSummary,
  storage: MissionControlStorageSummary,
  screen: MissionControlScreen,
  message: string
): Promise<MissionControlResponse> => {
  const service = new RouteLedgerQueryService({
    storage: new ReadOnlySnapshotStorage(snapshot)
  });
  const context = await service.getCurrentContext({
    projectId: snapshot.project.id,
    includeAllVersions: true
  });
  const contextData = context.data as CurrentContextData;
  const versions = snapshot.versions.slice().sort(versionSort);
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const childCountByVersionId = new Map<string, number>();
  const openTodoCountByVersionId = new Map<string, number>();
  const pendingDeferredCountByVersionId = new Map<string, number>();
  const activeConstraintCountByVersionId = new Map<string, number>();

  for (const version of versions) {
    childCountByVersionId.set(
      version.id,
      versions.filter((candidate) => candidate.parentVersionId === version.id).length
    );
    openTodoCountByVersionId.set(
      version.id,
      snapshot.todos.filter(
        (todo) => todo.versionId === version.id && (todo.status === "wait" || todo.status === "running")
      ).length
    );
    pendingDeferredCountByVersionId.set(
      version.id,
      snapshot.deferredItems.filter(
        (deferred) =>
          deferred.targetReviewVersionId === version.id && deferred.status === "pending"
      ).length
    );
    activeConstraintCountByVersionId.set(
      version.id,
      snapshot.constraints.filter(
        (constraint) =>
          constraint.status === "active" &&
          constraint.scope.type === "version" &&
          constraint.scope.versionId === version.id
      ).length
    );
  }

  const currentVersionId = snapshot.project.currentVersionId;
  const currentVersion =
    currentVersionId === null ? null : versions.find((version) => version.id === currentVersionId) ?? null;
  const treeSource =
    currentVersionId === null
      ? null
      : buildVersionStructureView(snapshot, {
          projectId: snapshot.project.id,
          versionId: currentVersionId
        });
  const pendingProposals = snapshot.pendingOperations
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .filter((proposal) => proposal.status === "pending")
    .map(toProposalSummary);
  const dueDeferredIdSet = new Set(contextData.dueDeferredIds);
  const buildVersionPanel = (version: Version): MissionControlCurrentVersion => {
    const versionTodos = snapshot.todos
          .filter(
            (todo) =>
              todo.versionId === version.id &&
              (todo.status === "wait" || todo.status === "running")
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map((todo) => ({
            id: todo.id,
            title: todo.title,
            description: todo.description,
            status: todo.status,
            updatedAt: todo.updatedAt
          }));
    const versionDeferred: MissionControlDeferredItem[] = snapshot.deferredItems
          .filter(
            (deferred) =>
              deferred.status === "pending" &&
              (deferred.originVersionId === version.id ||
                deferred.targetReviewVersionId === version.id)
          )
          .sort((left, right) => {
            const dueOrder =
              Number(dueDeferredIdSet.has(right.id)) - Number(dueDeferredIdSet.has(left.id));
            return dueOrder !== 0 ? dueOrder : right.updatedAt.localeCompare(left.updatedAt);
          })
          .map((deferred) => ({
            id: deferred.id,
            title: deferred.title,
            description: deferred.description,
            reason: deferred.reason,
            status: deferred.status,
            reviewTrigger: deferred.reviewTrigger,
            targetReviewVersionId: deferred.targetReviewVersionId,
            targetReviewVersionTitle:
              versionsById.get(deferred.targetReviewVersionId)?.title ??
              deferred.targetReviewVersionId,
            isDue: dueDeferredIdSet.has(deferred.id),
            updatedAt: deferred.updatedAt
          }));
    const versionConstraints: MissionControlConstraintItem[] = snapshot.constraints
          .filter(
            (constraint) =>
              constraint.status === "active" &&
              (constraint.scope.type === "project" ||
                constraint.scope.versionId === version.id)
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map((constraint) => ({
            id: constraint.id,
            rule: constraint.rule,
            rationale: constraint.rationale,
            scope:
              constraint.scope.type === "project" ? "project" : "current_version",
            status: constraint.status,
            updatedAt: constraint.updatedAt
          }));
    return {
      ...describeVersionState(version),
      id: version.id,
      title: version.title,
      description: version.description,
      state: version.state,
      order: version.order,
      updatedAt: version.updatedAt,
      previousVersionTitle:
        version.previousVersionId === null
          ? null
          : versionsById.get(version.previousVersionId)?.title ?? null,
      nextVersionTitle:
        version.nextVersionId === null
          ? null
          : versionsById.get(version.nextVersionId)?.title ?? null,
      parentVersionTitle:
        version.parentVersionId === null
          ? null
          : versionsById.get(version.parentVersionId)?.title ?? null,
      todos: versionTodos,
      deferred: versionDeferred,
      constraints: versionConstraints
    };
  };
  const openLegacyRecords = dedupeLegacyUndos(
    snapshot.undos.filter((undo) => undo.status === "wait")
  );
  const currentVersionLegacyBlockers =
    currentVersionId === null
      ? []
      : getBlockingUndosForVersion(snapshot.undos, currentVersionId);

  const roadmap = contextData.versions.map<MissionControlRoadmapItem>((summary) => {
    const version = versionsById.get(summary.id)!;
    return {
      id: summary.id,
      title: summary.title,
      order: summary.order,
      state: summary.state,
      displayLabel: summary.displayLabel,
      isCurrent: summary.isCurrent,
      isDiagnostic: summary.isDiagnostic,
      updatedAt: summary.updatedAt,
      parentVersionId: version.parentVersionId,
      previousVersionId: version.previousVersionId,
      nextVersionId: version.nextVersionId,
      childCount: childCountByVersionId.get(summary.id) ?? 0,
      openTodoCount: openTodoCountByVersionId.get(summary.id) ?? 0,
      pendingDeferredCount: pendingDeferredCountByVersionId.get(summary.id) ?? 0,
      activeConstraintCount: activeConstraintCountByVersionId.get(summary.id) ?? 0
    };
  });

  const versionDetails = versions.map(buildVersionPanel);
  const currentVersionPanel: MissionControlCurrentVersion | null =
    currentVersion === null
      ? null
      : versionDetails.find((version) => version.id === currentVersion.id) ?? null;

  const tree: MissionControlVersionTree | null =
    treeSource === null
      ? null
      : {
          focus: summarizeTreeNode(treeSource.focusVersion)!,
          parent:
        treeSource.parentVersion === null
          ? null
          : summarizeTreeNode({
              ...treeSource.parentVersion,
              description: versionsById.get(treeSource.parentVersion.id)?.description ?? ""
            }),
          siblings: treeSource.siblings
            .filter((version) => version.id !== treeSource.focusVersion.id)
            .map((version) =>
              summarizeTreeNode({
                ...version,
                description: versionsById.get(version.id)?.description ?? "",
                displayLabel: version.displayLabel
              })!
            ),
          children: treeSource.childVersions.map((version) =>
            summarizeTreeNode({
              ...version,
              description: versionsById.get(version.id)?.description ?? "",
              displayLabel: version.displayLabel
            })!
          )
        };

  return {
    generatedAt: new Date().toISOString(),
    screen,
    message,
    binding,
    storage,
    identity: {
      projectId: snapshot.project.id,
      projectName: snapshot.project.name,
      projectDescription: snapshot.project.description,
      projectStatus: snapshot.project.status,
      currentVersionId,
      currentVersionTitle: currentVersion?.title ?? null,
      currentVersionState: currentVersion?.state ?? null,
      currentVersionDisplayLabel:
        currentVersion === null ? null : describeVersionState(currentVersion).displayLabel,
      currentVersionStateReason:
        currentVersion === null ? null : describeVersionState(currentVersion).stateReason,
      currentVersionOrder: currentVersion?.order ?? null,
      versionCount: versions.length,
      updatedAt: snapshot.project.updatedAt
    },
    overview: {
      openTodoCount: snapshot.todos.filter(
        (todo) => todo.status === "wait" || todo.status === "running"
      ).length,
      pendingDeferredCount: snapshot.deferredItems.filter(
        (deferred) => deferred.status === "pending"
      ).length,
      dueDeferredCount: contextData.dueDeferredIds.length,
      activeConstraintCount: snapshot.constraints.filter(
        (constraint) => constraint.status === "active"
      ).length,
      pendingProposalCount: pendingProposals.length,
      activeWorkItemCount: snapshot.workItems.filter((workItem) => workItem.status === "active").length,
      diagnosticVersionCount: contextData.versions.filter((version) => version.isDiagnostic).length
    },
    roadmap,
    currentVersion: currentVersionPanel,
    versionDetails,
    tree,
    proposals: pendingProposals,
    approvals: snapshot.approvalArtifacts
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 8)
      .map(toApprovalSummary),
    auditTrail: snapshot.events
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 12)
      .map(toAuditEventSummary),
    legacyAudit: {
      openRecordCount: openLegacyRecords.length,
      currentVersionBlockerCount: currentVersionLegacyBlockers.length,
      records: openLegacyRecords
    },
    statusRisks: contextData.statusRisks,
    nextAction:
      contextData.nextAction === null
        ? null
        : {
            actionType: contextData.nextAction.actionType,
            summary: contextData.nextAction.summary,
            reason: contextData.nextAction.reason,
            targetId: contextData.nextAction.targetId,
            requiresL3Approval: contextData.nextAction.requiresL3Approval,
            blockingRiskCodes: contextData.nextAction.blockingRiskCodes
          }
  };
};

const createErrorResponse = (options: {
  binding: MissionControlBindingSummary;
  storage: MissionControlStorageSummary;
  screen: MissionControlScreen;
  message: string;
}): MissionControlResponse => ({
  generatedAt: new Date().toISOString(),
  screen: options.screen,
  message: options.message,
  binding: options.binding,
  storage: options.storage,
  identity: null,
  overview: null,
  roadmap: [],
  currentVersion: null,
  versionDetails: [],
  tree: null,
  proposals: [],
  approvals: [],
  auditTrail: [],
  legacyAudit: {
    openRecordCount: 0,
    currentVersionBlockerCount: 0,
    records: []
  },
  statusRisks: [],
  nextAction: null
});

export const buildMissionControlResponse = async (
  input: LauncherBindingInput
): Promise<MissionControlResponse> => {
  const binding = createBindingSummary(input);
  const sqlite =
    binding.routeledgerRoot === null
      ? {
          status: "absent" as const,
          dbPath: "",
          error: null
        }
      : describeUnusedSqliteReadModel(binding.routeledgerRoot);

  if (
    binding.status === "unbound" ||
    binding.status === "invalid"
  ) {
    return createErrorResponse({
      binding,
      storage: buildStorageSummary({
        mode: "binding_error",
        binding,
        canonicalStatus: "missing",
        sqlite
      }),
      screen: "binding_error",
      message: "workspace binding 不可用，无法定位 RouteLedger 真源。"
    });
  }

  try {
    const loaded = await loadValidatedProjectAggregateFromJsonDirectory(binding.routeledgerRoot!);
    const routeIsEmpty = loaded.snapshot.versions.length === 0;
    const screen: MissionControlScreen = loaded.snapshot.project.currentVersionId === null ? "current_closed" : "ready";
    const storage = buildStorageSummary({
      mode: "json",
      binding,
      canonicalStatus: "ready",
      sqlite
    });

    return buildMissionControlViewModel(
      loaded.snapshot,
      binding,
      storage,
      screen,
      screen === "current_closed"
        ? routeIsEmpty
          ? "项目已初始化，路线尚未定义；请创建首个真实 Version。"
          : "当前项目未设置 current version；可继续查看项目身份、路线与审计信息。"
        : sqlite.status === "degraded"
          ? "canonical JSON 已加载；SQLite read model 退化，仅作为诊断警告展示。"
          : "canonical JSON 已加载；当前页面处于只读模式。"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "canonical JSON 读取失败。";
    const looksMissing = message.includes("ENOENT") || message.includes("not found");

    return createErrorResponse({
      binding: {
        ...binding,
        status: looksMissing ? "uninitialized" : binding.status,
        diagnostics: looksMissing
          ? binding.diagnostics.concat("routeledgerRoot 下未找到可读取的 canonical .routeledger 文档。")
          : binding.diagnostics
      },
      storage: buildStorageSummary({
        mode: looksMissing ? "uninitialized" : "json_invalid",
        binding,
        canonicalStatus: looksMissing ? "missing" : "invalid",
        canonicalIssues: [message],
        sqlite
      }),
      screen: looksMissing ? "binding_error" : "json_error",
      message: looksMissing
        ? "未找到 canonical .routeledger；请核对 routeledgerRoot 是否指向正确项目。"
        : "canonical JSON 校验失败，页面未使用 SQLite 兜底。"
    });
  }
};
