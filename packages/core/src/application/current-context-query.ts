import type { Project } from "../domain/project.js";
import type { Constraint } from "../domain/constraint.js";
import type { DeferredItem } from "../domain/deferred-item.js";
import {
  describeVersionState,
  isShutdownStateReason,
  isUndoBlockingCloseForVersion
} from "../domain/route-semantics.js";
import type { Todo } from "../domain/todo.js";
import type { Undo } from "../domain/undo.js";
import type { Version } from "../domain/version.js";
import type { ProjectAggregateSnapshot } from "../ports/storage-port.js";
import {
  evaluateCloseGate,
  evaluateStartGate,
  resolveResidualAudit,
  type CloseGateResult,
  type StartGateResult
} from "../services/gate-service.js";

import { ApplicationError } from "./errors.js";
import type {
  CurrentContextNextAction,
  CurrentContextStatusRisk,
  GateSnapshot,
  PendingOperation,
  VersionWindowSummary
} from "./types.js";

const CONTEXT_MIN_BYTES = 8 * 1024;
const CONTEXT_DEFAULT_BYTES = 32 * 1024;
const CONTEXT_MAX_BYTES = 64 * 1024;
const DEFAULT_VERSION_WINDOW_BEFORE = 3;
const DEFAULT_VERSION_WINDOW_AFTER = 3;
const MAX_VERSION_WINDOW_SIZE = 20;
const DIAGNOSTIC_VERSION_PATTERNS = [/_probe/i, /\bprobe\b/i, /diagnostic/i, /test-only/i];

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
  status: Undo["status"];
  carriedForwardAt: string | null;
  carriedForwardToVersionId: string | null;
  title: string;
  reason: string;
  description: string;
  updatedAt: string;
};

type ContextDeferredSummary = {
  id: string;
  title: string;
  description: string;
  status: DeferredItem["status"];
  targetReviewVersionId: string;
  reason: string;
  reviewTrigger: string | null;
  updatedAt: string;
};

type ContextConstraintSummary = {
  id: string;
  rule: string;
  rationale: string;
  scope: Constraint["scope"];
  status: Constraint["status"];
  updatedAt: string;
};

type ContextPendingProposalSummary = {
  id: string;
  actionType: PendingOperation["actionType"];
  targetId: string;
  status: PendingOperation["status"];
  digest: string;
  reason: string;
  createdAt: string;
  gate: {
    kind: GateSnapshot["kind"];
    allowed: boolean;
    blockerCount: number;
  };
};

type CurrentContextRecommendedAction =
  | CurrentContextNextAction
  | (Omit<CurrentContextNextAction, "actionType"> & {
      actionType: "set_current_version";
    });

type RunningVersionPointerDrift = {
  uniqueRunningVersion: Version | null;
  hasMultipleRunningVersions: boolean;
};

type DerivedCurrentContextData = {
  project: {
    id: string;
    name: string;
    status: Project["status"];
    currentVersionId: string | null;
    contentLocale: string | null;
    updatedAt: string;
  };
  currentVersion: ContextCurrentVersionSummary | null;
  nextVersion: ContextVersionSummary | null;
  versions: ContextVersionSummary[];
  versionWindow: VersionWindowSummary;
  openTodos: ContextOpenTodoSummary[];
  currentTodos: ContextOpenTodoSummary[];
  openUndos: ContextOpenUndoSummary[];
  deferred: ContextDeferredSummary[];
  constraints: ContextConstraintSummary[];
  dueDeferred: ContextDeferredSummary[];
  dueDeferredIds: string[];
  unresolvedDeferredIds: string[];
  blockedConstraintIds: string[];
  gates: {
    start: (StartGateResult & { versionId: string }) | null;
    close: (CloseGateResult & { versionId: string }) | null;
  };
  pendingL3Proposals: ContextPendingProposalSummary[];
  statusRisks: CurrentContextStatusRisk[];
  nextAction: CurrentContextRecommendedAction;
};

type CurrentContextQueryOptions = {
  budgetBytes?: number;
  includeAllVersions?: boolean;
  versionWindowBefore?: number;
  versionWindowAfter?: number;
  includeLegacyUndo?: boolean;
};

type VersionsWindowQueryOptions = {
  aroundVersionId?: string | null;
  before?: number;
  after?: number;
};

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

const estimateBytes = (value: unknown): number => Buffer.byteLength(stableStringify(value), "utf8");

const sanitizeLegacyGateDetails = (gate: unknown): unknown => {
  if (gate === null || typeof gate !== "object") {
    return gate;
  }

  const sanitized = structuredClone(gate) as Record<string, unknown>;
  delete sanitized.dueUndoIds;
  delete sanitized.unresolvedUndoIds;

  if (Array.isArray(sanitized.blockers)) {
    sanitized.blockers = sanitized.blockers.map((blocker) => {
      if (
        blocker !== null &&
        typeof blocker === "object" &&
        typeof (blocker as { code?: unknown }).code === "string" &&
        (blocker as { code: string }).code.includes("UNDO")
      ) {
        return {
          code: "LEGACY_WORK_REQUIRES_AUDIT",
          message:
            "A legacy work record still affects this gate. Use get_current_context(includeLegacyUndo=true) for audit details.",
          recordIds: Array.isArray((blocker as { recordIds?: unknown }).recordIds)
            ? (blocker as { recordIds: unknown[] }).recordIds
            : []
        };
      }

      return blocker;
    });
  }

  return sanitized;
};

const sanitizeStatusRisksForAgent = (
  risks: CurrentContextStatusRisk[]
): CurrentContextStatusRisk[] =>
  risks.map((risk) =>
    risk.code === "OPEN_UNDOS_BLOCK_CLOSE"
      ? {
          ...risk,
          code: "LEGACY_WORK_BLOCKS_CLOSE",
          summary:
            "当前 version 存在仍会阻塞 close gate 的历史工作记录；需要显式打开 legacy audit 后处理。"
        }
      : risk
  );

const clampContextBudget = (budgetBytes: number | undefined, project: Project): number => {
  const preferred = budgetBytes ?? project.settings.contextBudgetBytes ?? CONTEXT_DEFAULT_BYTES;

  return Math.max(CONTEXT_MIN_BYTES, Math.min(CONTEXT_MAX_BYTES, preferred));
};

const clampVersionWindowSize = (value: number | undefined, fallback: number): number => {
  const preferred = value ?? fallback;

  return Math.max(0, Math.min(MAX_VERSION_WINDOW_SIZE, preferred));
};

const isDiagnosticVersion = (version: Pick<Version, "title">): boolean =>
  DIAGNOSTIC_VERSION_PATTERNS.some((pattern) => pattern.test(version.title));

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
  status: undo.status,
  carriedForwardAt: undo.carriedForwardAt,
  carriedForwardToVersionId: undo.carriedForwardToVersionId,
  title: undo.title,
  reason: undo.reason,
  description: undo.description,
  updatedAt: undo.updatedAt
});

const summarizeDeferred = (deferred: DeferredItem): ContextDeferredSummary => ({
  id: deferred.id,
  title: deferred.title,
  description: deferred.description,
  status: deferred.status,
  targetReviewVersionId: deferred.targetReviewVersionId,
  reason: deferred.reason,
  reviewTrigger: deferred.reviewTrigger,
  updatedAt: deferred.updatedAt
});

const summarizeConstraint = (constraint: Constraint): ContextConstraintSummary => ({
  id: constraint.id,
  rule: constraint.rule,
  rationale: constraint.rationale,
  scope: constraint.scope,
  status: constraint.status,
  updatedAt: constraint.updatedAt
});

const buildBlockingRiskCodes = (statusRisks: CurrentContextStatusRisk[]): string[] =>
  statusRisks
    .filter((risk) => risk.severity === "blocking")
    .map((risk) => risk.code);

const buildVersionWindow = (options: {
  versions: Version[];
  aroundVersionId: string | null;
  includeAllVersions: boolean;
  before: number;
  after: number;
}): {
  versions: ContextVersionSummary[];
  summary: VersionWindowSummary;
} => {
  const versions = options.versions.slice().sort((left, right) => left.order - right.order);

  if (versions.length === 0) {
    return {
      versions: [],
      summary: {
        aroundVersionId: options.aroundVersionId,
        before: options.before,
        after: options.after,
        includeAllVersions: options.includeAllVersions,
        totalCount: 0,
        includedCount: 0,
        omittedBeforeCount: 0,
        omittedAfterCount: 0
      }
    };
  }

  const effectiveAroundVersionId = options.aroundVersionId ?? versions[0]!.id;
  const aroundIndex = versions.findIndex((version) => version.id === effectiveAroundVersionId);

  if (aroundIndex === -1) {
    throw new ApplicationError("VERSION_NOT_FOUND", "version 不存在", {
      aroundVersionId: effectiveAroundVersionId
    });
  }

  const startIndex = options.includeAllVersions ? 0 : Math.max(0, aroundIndex - options.before);
  const endIndex = options.includeAllVersions
    ? versions.length
    : Math.min(versions.length, aroundIndex + options.after + 1);
  const includedVersions = versions.slice(startIndex, endIndex);

  return {
    versions: includedVersions.map(summarizeVersion),
    summary: {
      aroundVersionId: effectiveAroundVersionId,
      before: options.before,
      after: options.after,
      includeAllVersions: options.includeAllVersions,
      totalCount: versions.length,
      includedCount: includedVersions.length,
      omittedBeforeCount: startIndex,
      omittedAfterCount: versions.length - endIndex
    }
  };
};

const buildStatusRisks = (options: {
  currentVersion: Version | null;
  nextVersion: Version | null;
  currentVersionOpenTodos: ContextOpenTodoSummary[];
  currentVersionOpenUndos: ContextOpenUndoSummary[];
  pendingProposals: ContextPendingProposalSummary[];
  diagnosticVersions: Version[];
  runningVersionPointerDrift: RunningVersionPointerDrift;
  startGate: (StartGateResult & { versionId: string }) | null;
  closeGate: (CloseGateResult & { versionId: string }) | null;
}): CurrentContextStatusRisk[] => {
  const risks: CurrentContextStatusRisk[] = [];
  const {
    currentVersion,
    nextVersion,
    currentVersionOpenTodos,
    currentVersionOpenUndos,
    pendingProposals,
    diagnosticVersions,
    runningVersionPointerDrift,
    startGate,
    closeGate
  } = options;

  if (pendingProposals.length > 0) {
    risks.push({
      code: "PENDING_L3_PROPOSAL_NEEDS_DECISION",
      severity: "blocking",
      summary: "存在 pending L3 proposal，需要先审批或拒绝，再继续推进路线。",
      recordIds: pendingProposals.map((proposal) => proposal.id)
    });
  }

  if (currentVersion === null && nextVersion === null) {
    risks.push({
      code: "ROUTE_EMPTY",
      severity: "info",
      summary: "项目已初始化，但尚未定义任何真实 Version。",
      recordIds: []
    });
  }

  if (currentVersion?.state === "complete") {
    risks.push({
      code: "CURRENT_VERSION_COMPLETE_NOT_CLOSED",
      severity: "warning",
      summary: "current version 已 complete，但边界尚未 close。",
      recordIds: [currentVersion.id]
    });
  }

  if (currentVersion?.state === "close" && isShutdownStateReason(currentVersion.stateReason)) {
    risks.push({
      code: "CURRENT_VERSION_SHUTDOWN",
      severity: "warning",
      summary: `current version ${currentVersion.title} 是 SHUTDOWN/ABORTED close，继续推进前应先人工复核 forced path。`,
      recordIds: [currentVersion.id]
    });
  }

  if (currentVersion?.state === "complete" && currentVersionOpenTodos.length > 0) {
    risks.push({
      code: "OPEN_TODOS_BLOCK_CLOSE",
      severity: "blocking",
      summary: "当前 version 仍有 open todo，会阻塞 close gate。",
      recordIds: currentVersionOpenTodos.map((todo) => todo.id)
    });
  }

  if (currentVersion?.state === "complete" && currentVersionOpenUndos.length > 0) {
    risks.push({
      code: "OPEN_UNDOS_BLOCK_CLOSE",
      severity: "blocking",
      summary: "当前 version 仍有 open undo，会阻塞 close gate。",
      recordIds: currentVersionOpenUndos.map((undo) => undo.id)
    });
  }

  if (
    currentVersion?.state === "complete" &&
    closeGate !== null &&
    closeGate.unresolvedDeferredIds.length > 0
  ) {
    risks.push({
      code: "UNRESOLVED_DEFERRED_BLOCKS_CLOSE",
      severity: "blocking",
      summary: "当前 version 存在未正确路由的 Deferred，会阻塞 close gate。",
      recordIds: closeGate.unresolvedDeferredIds
    });
  }

  if (startGate !== null && startGate.dueDeferredIds.length > 0) {
    risks.push({
      code: "DUE_DEFERRED_REQUIRES_REVIEW",
      severity: "blocking",
      summary: "目标 version 有到期 Deferred，启动前必须完成 review。",
      recordIds: startGate.dueDeferredIds
    });
  }

  if (
    startGate !== null &&
    !startGate.allowed &&
    startGate.blockers.some(
      (blocker) => blocker.code !== "DUE_DEFERRED_REQUIRES_REVIEW"
    )
  ) {
    risks.push({
      code: "START_GATE_BLOCKED",
      severity: "blocking",
      summary:
        "目标 version 的 start gate 仍有 blocker；需要先审计并处理，再尝试启动。",
      recordIds: startGate.blockers
        .filter(
          (blocker) => blocker.code !== "DUE_DEFERRED_REQUIRES_REVIEW"
        )
        .flatMap((blocker) => blocker.recordIds)
    });
  }

  if (runningVersionPointerDrift.uniqueRunningVersion !== null && currentVersion !== null) {
    risks.push({
      code: "CURRENT_POINTER_DRIFT_RUNNING_VERSION",
      severity: "warning",
      summary: `project.currentVersionId 当前指向 ${currentVersion.title}，但唯一 running version 是 ${runningVersionPointerDrift.uniqueRunningVersion.title}；应通过 L3 set_current_version 修正 current。`,
      recordIds: [currentVersion.id, runningVersionPointerDrift.uniqueRunningVersion.id]
    });
  }

  if (
    currentVersion?.state === "close" &&
    nextVersion !== null &&
    (nextVersion.state === "wait" || nextVersion.state === "ready")
  ) {
    risks.push({
      code: "CURRENT_VERSION_CLOSED_NEXT_VERSION_WAITING",
      severity: "info",
      summary: `current 指向已关闭边界；下一个 version ${nextVersion.title} 仍处于 ${nextVersion.state}。`,
      recordIds: [currentVersion.id, nextVersion.id]
    });
  }

  if (diagnosticVersions.length > 0) {
    risks.push({
      code: "DIAGNOSTIC_VERSION_NOISE",
      severity: "info",
      summary: "版本列表中存在 probe/diagnostic 命名版本，可能干扰真实路线判断。",
      recordIds: diagnosticVersions.map((version) => version.id)
    });
  }

  return risks;
};

const buildNextAction = (options: {
  projectId: string;
  currentVersion: Version | null;
  nextVersion: Version | null;
  currentVersionOpenTodos: ContextOpenTodoSummary[];
  currentVersionOpenUndos: ContextOpenUndoSummary[];
  pendingProposals: ContextPendingProposalSummary[];
  statusRisks: CurrentContextStatusRisk[];
  runningVersionPointerDrift: RunningVersionPointerDrift;
  startGate: (StartGateResult & { versionId: string }) | null;
  closeGate: (CloseGateResult & { versionId: string }) | null;
}): CurrentContextRecommendedAction => {
  const {
    projectId,
    currentVersion,
    nextVersion,
    currentVersionOpenTodos,
    currentVersionOpenUndos,
    pendingProposals,
    statusRisks,
    runningVersionPointerDrift,
    startGate,
    closeGate
  } = options;
  const blockingRiskCodes = buildBlockingRiskCodes(statusRisks);

  if (pendingProposals.length > 0) {
    const proposal = pendingProposals[0]!;

    return {
      actionType: "review_pending_proposal",
      summary: "先处理 pending L3 proposal。",
      reason: `待处理提案 ${proposal.id} 会影响后续路线判断，应先审批或拒绝。`,
      targetId: proposal.id,
      requiresL3Approval: true,
      recordIds: [proposal.id],
      blockingRiskCodes: ["PENDING_L3_PROPOSAL_NEEDS_DECISION"]
    };
  }

  if (currentVersion === null && nextVersion === null) {
    return {
      actionType: "create_version",
      summary: "与用户确认后创建首个真实 Version。",
      reason: "Project 逻辑根已经存在，但路线仍为空；首个 Version 应表达真实交付边界。",
      targetId: null,
      requiresL3Approval: true,
      recordIds: [],
      blockingRiskCodes
    };
  }

  if (currentVersion?.state === "close" && isShutdownStateReason(currentVersion.stateReason)) {
    return {
      actionType: "review_context",
      summary: "当前 version 处于 SHUTDOWN/ABORTED close。",
      reason: `version ${currentVersion.id} 使用 forced shutdown 路径关闭（${currentVersion.stateReason}）；不要把它当作普通 close 自动推进。`,
      targetId: currentVersion.id,
      requiresL3Approval: false,
      recordIds: [currentVersion.id],
      blockingRiskCodes: ["CURRENT_VERSION_SHUTDOWN", ...blockingRiskCodes]
    };
  }

  if (currentVersion?.state === "running" && currentVersionOpenTodos.length > 0) {
    const todo = currentVersionOpenTodos[0]!;

    return {
      actionType: "work_todo",
      summary: "继续处理当前 version 的 open todo。",
      reason: `todo ${todo.id} 是当前 version 按稳定顺序返回的首个开放工作项；该顺序用于确定性导航，不代表业务优先级。`,
      targetId: todo.id,
      requiresL3Approval: false,
      recordIds: currentVersionOpenTodos.map((item) => item.id),
      blockingRiskCodes
    };
  }

  if (currentVersion?.state === "complete" && currentVersionOpenTodos.length > 0) {
    const todo = currentVersionOpenTodos[0]!;

    return {
      actionType: "close_todo",
      summary: "先收口当前 version 的 open todo。",
      reason: `todo ${todo.id} 仍未关闭，close gate 不能通过。`,
      targetId: todo.id,
      requiresL3Approval: false,
      recordIds: currentVersionOpenTodos.map((item) => item.id),
      blockingRiskCodes: ["OPEN_TODOS_BLOCK_CLOSE"]
    };
  }

  if (currentVersion?.state === "complete" && currentVersionOpenUndos.length > 0) {
    const undo = currentVersionOpenUndos[0]!;

    return {
      actionType: "review_context",
      summary: "当前 version 存在需要审计的历史工作项。",
      reason: `历史工作项 ${undo.id} 仍阻塞 close gate；请用 get_current_context(includeLegacyUndo=true) 审计后处理。`,
      targetId: undo.id,
      requiresL3Approval: false,
      recordIds: currentVersionOpenUndos.map((item) => item.id),
      blockingRiskCodes: ["LEGACY_WORK_BLOCKS_CLOSE"]
    };
  }

  if (
    currentVersion?.state === "complete" &&
    closeGate !== null &&
    closeGate.blockers.length > 0 &&
    closeGate.blockers.every((blocker) => blocker.code === "MISSING_RESIDUAL_AUDIT")
  ) {
    return {
      actionType: "review_residual_audit",
      recommendedTool: "check_close_gate",
      toolInput: {
        projectId,
        versionId: currentVersion.id,
        residualAudit: { status: "reviewed", items: [] }
      },
      summary: "Review and declare the residual audit first.",
      reason:
        "The ordinary close gate has no reviewed residual-audit declaration. Review residual work, then submit the provided declaration with any routed residual items.",
      targetId: currentVersion.id,
      requiresL3Approval: false,
      recordIds: [currentVersion.id],
      blockingRiskCodes: ["MISSING_RESIDUAL_AUDIT"]
    };
  }

  if (
    currentVersion?.state === "complete" &&
    closeGate !== null &&
    !closeGate.allowed
  ) {
    const deferredIds = closeGate.unresolvedDeferredIds;

    return {
      actionType:
        deferredIds.length > 0 ? "review_deferred" : "review_context",
      summary:
        deferredIds.length > 0
          ? "先修正当前 version 的 Deferred 路由。"
          : "先处理 close gate blocker。",
      reason: `current version ${currentVersion.id} 的真实 close gate 尚未通过。`,
      targetId: deferredIds[0] ?? currentVersion.id,
      requiresL3Approval: false,
      recordIds:
        deferredIds.length > 0
          ? deferredIds
          : closeGate.blockers.flatMap((blocker) => blocker.recordIds),
      blockingRiskCodes: closeGate.blockers.map((blocker) => blocker.code)
    };
  }

  if (runningVersionPointerDrift.uniqueRunningVersion !== null && currentVersion !== null) {
    const runningVersion = runningVersionPointerDrift.uniqueRunningVersion;

    return {
      actionType: "set_current_version",
      summary: "先把 current 指针切到唯一 running version。",
      reason: `project.currentVersionId 当前仍指向 ${currentVersion.id}，但实际运行中的边界是 ${runningVersion.id}；需要走 L3 set_current_version 修正 current。`,
      targetId: runningVersion.id,
      requiresL3Approval: true,
      recordIds: [currentVersion.id, runningVersion.id],
      blockingRiskCodes
    };
  }

  if (runningVersionPointerDrift.hasMultipleRunningVersions && currentVersion?.state !== "running") {
    return {
      actionType: "none",
      summary: "存在多个 running version，先停止自动 target 建议。",
      reason: "当前上下文里检测到多个 running version；在未澄清真实 active route 前，不应自动推荐单一 version target。",
      targetId: null,
      requiresL3Approval: false,
      recordIds: [],
      blockingRiskCodes
    };
  }

  if (currentVersion?.state === "complete") {
    return {
      actionType: "close_version",
      summary: "准备 residual audit 后，发起 close_version。",
      reason: `current version ${currentVersion.id} 已 complete，但尚未 close。`,
      targetId: currentVersion.id,
      requiresL3Approval: true,
      recordIds: [currentVersion.id],
      blockingRiskCodes
    };
  }

  if (currentVersion?.state === "wait") {
    return {
      actionType: "prepare_version",
      summary: "准备当前 version。",
      reason: `current version ${currentVersion.id} 仍处于 wait，需先 prepare_version。`,
      targetId: currentVersion.id,
      requiresL3Approval: false,
      recordIds: [currentVersion.id],
      blockingRiskCodes
    };
  }

  if (currentVersion?.state === "close" && nextVersion?.state === "wait") {
    return {
      actionType: "prepare_version",
      summary: "准备下一个 version。",
      reason: `当前边界已关闭，下一个 version ${nextVersion.id} 仍处于 wait。`,
      targetId: nextVersion.id,
      requiresL3Approval: false,
      recordIds: [currentVersion.id, nextVersion.id],
      blockingRiskCodes
    };
  }

  if (currentVersion?.state === "close" && nextVersion?.state === "ready") {
    if (startGate !== null && startGate.dueDeferredIds.length > 0) {
      return {
        actionType: "review_deferred",
        summary: "启动下一个 version 前先 review 到期 Deferred。",
        reason: `目标 version ${startGate.versionId} 有到期 Deferred。`,
        targetId: startGate.dueDeferredIds[0]!,
        requiresL3Approval: false,
        recordIds: startGate.dueDeferredIds,
        blockingRiskCodes
      };
    }

    if (startGate !== null && !startGate.allowed) {
      return {
        actionType: "review_context",
        summary: "启动下一个 version 前先处理 start gate blocker。",
        reason: `目标 version ${startGate.versionId} 的 start gate 尚未通过；请先审计当前上下文。`,
        targetId: startGate.versionId,
        requiresL3Approval: false,
        recordIds: startGate.blockers.flatMap(
          (blocker) => blocker.recordIds
        ),
        blockingRiskCodes: ["START_GATE_BLOCKED"]
      };
    }

    return {
      actionType: "advance_to_version",
      summary: "原子切换并启动下一个 ready Version。",
      reason: `当前边界已关闭，下一个 Version ${nextVersion.id} 已 ready，可用一套 L3 审计链完成 current 切换和启动。`,
      targetId: nextVersion.id,
      requiresL3Approval: true,
      recordIds: [currentVersion.id, nextVersion.id],
      blockingRiskCodes
    };
  }

  if (
    currentVersion?.state === "ready" &&
    startGate !== null &&
    startGate.dueDeferredIds.length > 0
  ) {
    return {
      actionType: "review_deferred",
      summary: "启动 current version 前先 review 到期 Deferred。",
      reason: `目标 version ${startGate.versionId} 有到期 Deferred。`,
      targetId: startGate.dueDeferredIds[0]!,
      requiresL3Approval: false,
      recordIds: startGate.dueDeferredIds,
      blockingRiskCodes
    };
  }

  if (
    currentVersion?.state === "ready" &&
    startGate !== null &&
    !startGate.allowed
  ) {
    return {
      actionType: "review_context",
      summary: "启动 current version 前先处理 start gate blocker。",
      reason: `目标 version ${startGate.versionId} 的 start gate 尚未通过；请先审计当前上下文。`,
      targetId: startGate.versionId,
      requiresL3Approval: false,
      recordIds: startGate.blockers.flatMap(
        (blocker) => blocker.recordIds
      ),
      blockingRiskCodes: ["START_GATE_BLOCKED"]
    };
  }

  if (currentVersion?.state === "ready" && startGate?.allowed) {
    return {
      actionType: "start_version",
      summary: "启动当前 ready version。",
      reason: `current version ${currentVersion.id} 已 ready 且 start gate 通过，可进入 start_version 审计链。`,
      targetId: currentVersion.id,
      requiresL3Approval: true,
      recordIds: [currentVersion.id],
      blockingRiskCodes
    };
  }

  if (
    currentVersion?.state === "close" &&
    currentVersion.parentVersionId === null &&
    currentVersion.nextVersionId === null &&
    nextVersion === null
  ) {
    return {
      actionType: "create_version",
      recommendedTool: "create_version",
      summary: "Append one successor Version after the closed top-level tail.",
      reason: `version ${currentVersion.id} is the ordinary closed top-level tail; continue the route by appending one real successor Version.`,
      targetId: currentVersion.id,
      requiresL3Approval: true,
      recordIds: [currentVersion.id],
      blockingRiskCodes
    };
  }

  return {
    actionType: "none",
    summary: "当前没有明确的单一步骤建议。",
    reason: "现有上下文没有落到明确的下一步模板，请结合版本状态进一步判断。",
    targetId: null,
    requiresL3Approval: false,
    recordIds: [],
    blockingRiskCodes
  };
};

export const buildDerivedCurrentContextData = (
  snapshot: ProjectAggregateSnapshot,
  options: Omit<CurrentContextQueryOptions, "budgetBytes"> = {}
): DerivedCurrentContextData => {
  const versions = snapshot.versions.slice().sort((left, right) => left.order - right.order);
  const currentVersion =
    snapshot.project.currentVersionId === null
      ? null
      : versions.find((version) => version.id === snapshot.project.currentVersionId) ?? null;
  const runningVersions = versions.filter((version) => version.state === "running");
  const runningVersionPointerDrift: RunningVersionPointerDrift = {
    uniqueRunningVersion:
      currentVersion !== null &&
      runningVersions.length === 1 &&
      runningVersions[0]!.id !== currentVersion.id
        ? runningVersions[0]!
        : null,
    hasMultipleRunningVersions: runningVersions.length > 1
  };
  const currentVersionIndex =
    currentVersion === null ? -1 : versions.findIndex((version) => version.id === currentVersion.id);
  const nextVersion = currentVersionIndex === -1 ? null : versions[currentVersionIndex + 1] ?? null;
  const versionWindowBefore = clampVersionWindowSize(
    options.versionWindowBefore,
    DEFAULT_VERSION_WINDOW_BEFORE
  );
  const versionWindowAfter = clampVersionWindowSize(
    options.versionWindowAfter,
    DEFAULT_VERSION_WINDOW_AFTER
  );
  const versionWindow = buildVersionWindow({
    versions,
    aroundVersionId: currentVersion?.id ?? null,
    includeAllVersions: options.includeAllVersions ?? false,
    before: versionWindowBefore,
    after: versionWindowAfter
  });
  const versionOrderById = new Map(
    versions.map((version) => [version.id, version.order] as const)
  );
  const todoCreationEventById = new Map(
    snapshot.events
      .filter(
        (event) =>
          event.targetType === "todo" && event.eventType === "todo.created"
      )
      .map((event) => [event.targetId, event] as const)
  );
  const openTodos = snapshot.todos
    .filter((todo) => todo.status === "wait" || todo.status === "running")
    .slice()
    .sort((left, right) => {
      const orderDifference =
        (versionOrderById.get(left.versionId) ?? Number.MAX_SAFE_INTEGER) -
        (versionOrderById.get(right.versionId) ?? Number.MAX_SAFE_INTEGER);
      if (orderDifference !== 0) {
        return orderDifference;
      }

      const createdAtDifference = left.createdAt.localeCompare(right.createdAt);
      if (createdAtDifference !== 0) {
        return createdAtDifference;
      }

      const leftCreation = todoCreationEventById.get(left.id);
      const rightCreation = todoCreationEventById.get(right.id);
      if (
        leftCreation !== undefined &&
        rightCreation !== undefined &&
        leftCreation.operationId === rightCreation.operationId
      ) {
        const batchIndexDifference =
          leftCreation.operationSeq - rightCreation.operationSeq;
        if (batchIndexDifference !== 0) {
          return batchIndexDifference;
        }
      }

      return left.id.localeCompare(right.id, "en");
    })
    .map(summarizeOpenTodo);
  const openUndos = snapshot.undos
    .filter((undo) => undo.status === "wait")
    .map(summarizeOpenUndo);
  const deferred = snapshot.deferredItems
    .filter((item) => item.status === "pending")
    .map(summarizeDeferred);
  const constraints = snapshot.constraints
    .filter((constraint) => constraint.status === "active")
    .map(summarizeConstraint);
  const pendingProposals = snapshot.pendingOperations
    .filter((operation) => operation.status === "pending")
    .map((operation) => ({
      id: operation.id,
      actionType: operation.actionType,
      targetId: operation.targetId,
      status: operation.status,
      digest: operation.digest.value,
      reason: operation.reason,
      createdAt: operation.createdAt,
      gate: {
        kind: operation.gateSnapshot.kind,
        allowed: operation.gateSnapshot.allowed,
        blockerCount: operation.gateSnapshot.blockers.length
      }
    }));
  const currentVersionOpenTodos =
    currentVersion === null ? [] : openTodos.filter((todo) => todo.versionId === currentVersion.id);
  const currentVersionOpenUndos =
    currentVersion === null
      ? []
      : openUndos.filter(
          (undo) =>
            (undo.versionId === currentVersion.id ||
              undo.originVersionId === currentVersion.id ||
              undo.preferredResolutionVersionId === currentVersion.id) &&
            isUndoBlockingCloseForVersion(undo, currentVersion.id)
        );
  const startTargetVersion =
    currentVersion?.state === "ready"
      ? currentVersion
      : nextVersion?.state === "ready"
        ? nextVersion
        : null;
  const startGate =
    startTargetVersion === null
      ? null
      : {
          ...evaluateStartGate({
            targetVersion: startTargetVersion,
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
          }),
          versionId: startTargetVersion.id
        };
  const currentResidualAudit =
    currentVersion === null
      ? null
      : resolveResidualAudit(
          undefined,
          snapshot.pendingOperations
            .filter(
              (operation) =>
                operation.status === "pending" &&
                operation.actionType === "close_version" &&
                operation.targetId === currentVersion.id
            )
            .slice()
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .map((operation) => ({
              id: operation.id,
              residualAudit: operation.payload.residualAudit,
              residualAuditReviewed: operation.payload.residualAuditReviewed
            }))
        );
  const closeGate =
    currentVersion === null || currentVersion.state === "close"
      ? null
      : {
          ...evaluateCloseGate({
            version: currentVersion,
            todos: snapshot.todos.filter(
              (todo) => todo.versionId === currentVersion.id
            ),
            undos: snapshot.undos.filter(
              (undo) =>
                undo.versionId === currentVersion.id ||
                undo.originVersionId === currentVersion.id ||
                undo.preferredResolutionVersionId === currentVersion.id
            ),
            residualAudit: currentResidualAudit?.audit ?? null,
            knownVersions: snapshot.versions,
            deferredItems: snapshot.deferredItems,
            constraints: snapshot.constraints,
            constraintChecks: []
          }),
          versionId: currentVersion.id
        };
  const diagnosticVersions = versions.filter(isDiagnosticVersion);
  const statusRisks = buildStatusRisks({
    currentVersion,
    nextVersion,
    currentVersionOpenTodos,
    currentVersionOpenUndos,
    pendingProposals,
    diagnosticVersions,
    runningVersionPointerDrift,
    startGate,
    closeGate
  });
  const nextAction = buildNextAction({
    projectId: snapshot.project.id,
    currentVersion,
    nextVersion,
    currentVersionOpenTodos,
    currentVersionOpenUndos,
    pendingProposals,
    statusRisks,
    runningVersionPointerDrift,
    startGate,
    closeGate
  });
  const dueDeferredIds = startGate?.dueDeferredIds ?? [];
  const dueDeferredIdSet = new Set(dueDeferredIds);

  return {
    project: {
      id: snapshot.project.id,
      name: snapshot.project.name,
      status: snapshot.project.status,
      currentVersionId: snapshot.project.currentVersionId,
      contentLocale: snapshot.project.settings.contentLocale,
      updatedAt: snapshot.project.updatedAt
    },
    currentVersion: currentVersion === null ? null : summarizeCurrentVersion(currentVersion),
    nextVersion: nextVersion === null ? null : summarizeVersion(nextVersion),
    versions: versionWindow.versions,
    versionWindow: versionWindow.summary,
    openTodos,
    currentTodos: currentVersionOpenTodos,
    openUndos,
    deferred,
    constraints,
    dueDeferred: deferred.filter((item) => dueDeferredIdSet.has(item.id)),
    dueDeferredIds,
    unresolvedDeferredIds: closeGate?.unresolvedDeferredIds ?? [],
    blockedConstraintIds: [
      ...new Set([
        ...(startGate?.blockedConstraintIds ?? []),
        ...(closeGate?.blockedConstraintIds ?? [])
      ])
    ],
    gates: {
      start: startGate,
      close: closeGate
    },
    pendingL3Proposals: pendingProposals,
    statusRisks,
    nextAction
  };
};

export const buildVersionsWindowResult = (
  snapshot: ProjectAggregateSnapshot,
  input: VersionsWindowQueryOptions
) => {
  const versions = snapshot.versions.slice().sort((left, right) => left.order - right.order);
  const before = clampVersionWindowSize(input.before, DEFAULT_VERSION_WINDOW_BEFORE);
  const after = clampVersionWindowSize(input.after, DEFAULT_VERSION_WINDOW_AFTER);
  const aroundVersionId = input.aroundVersionId ?? snapshot.project.currentVersionId ?? null;
  const versionWindow = buildVersionWindow({
    versions,
    aroundVersionId,
    includeAllVersions: false,
    before,
    after
  });

  return {
    data: {
      project: {
        id: snapshot.project.id,
        name: snapshot.project.name,
        currentVersionId: snapshot.project.currentVersionId,
        contentLocale: snapshot.project.settings.contentLocale
      },
      aroundVersionId: versionWindow.summary.aroundVersionId,
      versions: versionWindow.versions
    },
    meta: {
      versionWindow: versionWindow.summary
    }
  };
};

export const buildCurrentContextResult = (
  snapshot: ProjectAggregateSnapshot,
  input: CurrentContextQueryOptions
) => {
  const budgetBytes = clampContextBudget(input.budgetBytes, snapshot.project);
  const baseContext = buildDerivedCurrentContextData(snapshot, {
    includeAllVersions: input.includeAllVersions,
    versionWindowBefore: input.versionWindowBefore,
    versionWindowAfter: input.versionWindowAfter
  });

  const truncatedFields: string[] = [];
  const omittedCounts: Record<string, number> = {};
  const data = structuredClone(baseContext) as Record<string, unknown>;
  delete data.versionWindow;
  data.todos = baseContext.openTodos;
  delete data.openTodos;
  data.todoScopes = {
    todos: "all_open_route",
    currentTodos: "current_version_open"
  };
  delete data.openUndos;
  data.gates = {
    start: sanitizeLegacyGateDetails(baseContext.gates.start),
    close: sanitizeLegacyGateDetails(baseContext.gates.close)
  };
  data.statusRisks = sanitizeStatusRisksForAgent(baseContext.statusRisks);
  if (input.includeLegacyUndo === true) {
    data.legacyUndo = baseContext.openUndos;
  }

  if (estimateBytes(data) > budgetBytes) {
    if (data.currentVersion !== null && typeof data.currentVersion === "object") {
      delete (data.currentVersion as Record<string, unknown>).description;
      truncatedFields.push("currentVersion.description");
    }

    data.todos = baseContext.openTodos.map((todo) => ({
      id: todo.id,
      versionId: todo.versionId,
      title: todo.title,
      status: todo.status,
      updatedAt: todo.updatedAt
    }));
    data.currentTodos = baseContext.currentTodos.map((todo) => ({
      id: todo.id,
      versionId: todo.versionId,
      title: todo.title,
      status: todo.status,
      updatedAt: todo.updatedAt
    }));
    if (input.includeLegacyUndo === true) {
      data.legacyUndo = baseContext.openUndos.map((undo) => ({
        id: undo.id,
        versionId: undo.versionId,
        preferredResolutionVersionId: undo.preferredResolutionVersionId,
        title: undo.title,
        reason: undo.reason,
        updatedAt: undo.updatedAt
      }));
    }
    data.deferred = baseContext.deferred.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      targetReviewVersionId: item.targetReviewVersionId,
      reason: item.reason,
      reviewTrigger: item.reviewTrigger,
      updatedAt: item.updatedAt
    }));
    data.dueDeferred = baseContext.dueDeferred.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      targetReviewVersionId: item.targetReviewVersionId,
      reviewTrigger: item.reviewTrigger,
      updatedAt: item.updatedAt
    }));
    data.constraints = baseContext.constraints.map((constraint) => ({
      id: constraint.id,
      rule: constraint.rule,
      scope: constraint.scope,
      status: constraint.status,
      updatedAt: constraint.updatedAt
    }));
    data.pendingL3Proposals = baseContext.pendingL3Proposals.map((proposal) => ({
      id: proposal.id,
      actionType: proposal.actionType,
      targetId: proposal.targetId,
      status: proposal.status,
      digest: proposal.digest,
      createdAt: proposal.createdAt,
      gate: proposal.gate
    }));
    truncatedFields.push(
      "todos.description",
      "currentTodos.description",
      "deferred.description",
      "constraints.rationale",
      "pendingL3Proposals.reason"
    );
    if (input.includeLegacyUndo === true) {
      truncatedFields.push("legacyUndo.description");
    }
  }

  if (estimateBytes(data) > budgetBytes) {
    const maxItems = 3;
    const todosArray = data.todos as unknown[];
    const currentTodosArray = data.currentTodos as unknown[];
    const deferredArray = data.deferred as unknown[];
    const dueDeferredArray = data.dueDeferred as unknown[];
    const constraintsArray = data.constraints as unknown[];
    const legacyUndoArray = (data.legacyUndo ?? []) as unknown[];
    const proposalsArray = data.pendingL3Proposals as unknown[];

    if (todosArray.length > maxItems) {
      omittedCounts.todos = todosArray.length - maxItems;
      data.todos = todosArray.slice(0, maxItems);
    }

    if (currentTodosArray.length > maxItems) {
      omittedCounts.currentTodos = currentTodosArray.length - maxItems;
      data.currentTodos = currentTodosArray.slice(0, maxItems);
    }

    if (deferredArray.length > maxItems) {
      omittedCounts.deferred = deferredArray.length - maxItems;
      data.deferred = deferredArray.slice(0, maxItems);
    }

    if (dueDeferredArray.length > maxItems) {
      omittedCounts.dueDeferred = dueDeferredArray.length - maxItems;
      data.dueDeferred = dueDeferredArray.slice(0, maxItems);
    }

    if (constraintsArray.length > maxItems) {
      omittedCounts.constraints = constraintsArray.length - maxItems;
      data.constraints = constraintsArray.slice(0, maxItems);
    }

    if (legacyUndoArray.length > maxItems) {
      omittedCounts.legacyUndo = legacyUndoArray.length - maxItems;
      data.legacyUndo = legacyUndoArray.slice(0, maxItems);
    }

    if (proposalsArray.length > maxItems) {
      omittedCounts.pendingL3Proposals = proposalsArray.length - maxItems;
      data.pendingL3Proposals = proposalsArray.slice(0, maxItems);
    }
  }

  const payloadBytes = estimateBytes(data);

  return {
    data,
    meta: {
      budgetBytes,
      payloadBytes,
      truncated:
        payloadBytes > budgetBytes ||
        truncatedFields.length > 0 ||
        Object.keys(omittedCounts).length > 0,
      hasMore: Object.keys(omittedCounts).length > 0,
      truncatedFields,
      omittedCounts,
      versionWindow: baseContext.versionWindow
    }
  };
};

export const buildNextActionResult = (
  snapshot: ProjectAggregateSnapshot,
  input: Omit<CurrentContextQueryOptions, "budgetBytes">
) => {
  const context = buildDerivedCurrentContextData(snapshot, {
    includeAllVersions: input.includeAllVersions,
    versionWindowBefore: input.versionWindowBefore,
    versionWindowAfter: input.versionWindowAfter
  });

  return {
    data: {
      project: context.project,
      currentVersion: context.currentVersion,
      nextVersion: context.nextVersion,
      todos: context.openTodos,
      currentTodos: context.currentTodos,
      todoScopes: {
        todos: "all_open_route",
        currentTodos: "current_version_open"
      },
      deferred: context.deferred,
      constraints: context.constraints,
      dueDeferred: context.dueDeferred,
      dueDeferredIds: context.dueDeferredIds,
      unresolvedDeferredIds: context.unresolvedDeferredIds,
      blockedConstraintIds: context.blockedConstraintIds,
      gates: {
        start: sanitizeLegacyGateDetails(context.gates.start),
        close: sanitizeLegacyGateDetails(context.gates.close)
      },
      pendingL3Proposals: context.pendingL3Proposals,
      statusRisks: sanitizeStatusRisksForAgent(context.statusRisks),
      nextAction: context.nextAction
    }
  };
};
