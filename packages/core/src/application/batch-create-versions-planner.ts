import type { ProjectAggregateSnapshot } from "../ports/storage-port.js";
import {
  applyVersionTreeMutation,
  normalizeVersionTreePayload
} from "../services/version-tree-service.js";

import { ApplicationError } from "./errors.js";
import {
  BATCH_PREVIOUS_CURRENT_POLICIES,
  isBatchPreviousCurrentPolicy
} from "./types.js";
import type {
  BatchCreateVersionsAnchor,
  BatchCreateVersionsIssue,
  BatchCreateVersionsItemInput,
  BatchCreateVersionsNormalizedItem,
  BatchCreateVersionsNotice,
  BatchCreateVersionsResolvedAnchors,
  BatchPreviousCurrentPolicy,
  OperationDigest,
  PendingOperationPayload
} from "./types.js";

export interface EvaluateBatchCreateVersionsInput {
  anchor?: BatchCreateVersionsAnchor;
  items: BatchCreateVersionsItemInput[];
  partialAllowed?: boolean;
  previousCurrentPolicy?: BatchPreviousCurrentPolicy;
  setCurrentTo?: string;
}

export interface BatchCreateVersionsPlanSummary {
  requestedCount: number;
  validCount: number;
  invalidCount: number;
}

export interface BatchCreateVersionsNormalizedPlan {
  partialAllowed: false;
  anchor: BatchCreateVersionsAnchor;
  items: BatchCreateVersionsNormalizedItem[];
  setCurrentTo: string | null;
  previousCurrentPolicy: BatchPreviousCurrentPolicy;
}

export interface BatchCreateVersionsPreviewVersion {
  clientKey: string;
  previewVersionId: string;
  title: string;
  description: string;
  parentVersionId: string | null;
  previousRef: string | null;
  nextRef: string | null;
}

export interface BatchCreateVersionsPreviewTodo {
  versionClientKey: string;
  previewVersionId: string;
  title: string;
}

export interface BatchCreateVersionsPreview {
  createdVersions: BatchCreateVersionsPreviewVersion[];
  createdTodos: BatchCreateVersionsPreviewTodo[];
  setCurrentTo: string | null;
}

export interface BatchCreateVersionsFailure {
  ok: false;
  code: "BATCH_VERSION_PLAN_INVALID" | "BATCH_VERSION_PLAN_BLOCKED";
  headRevision?: string | null;
  summary: BatchCreateVersionsPlanSummary;
  issues: BatchCreateVersionsIssue[];
  risks: BatchCreateVersionsNotice[];
  blockers: BatchCreateVersionsNotice[];
  normalizedPlan?: BatchCreateVersionsNormalizedPlan;
  resolvedAnchors?: BatchCreateVersionsResolvedAnchors;
  preview?: BatchCreateVersionsPreview;
  digestPreview?: OperationDigest;
}

export const assertBatchPreviousCurrentPolicy = (
  previousCurrentPolicy: unknown
): BatchPreviousCurrentPolicy | undefined => {
  if (previousCurrentPolicy === undefined) {
    return undefined;
  }

  if (isBatchPreviousCurrentPolicy(previousCurrentPolicy)) {
    return previousCurrentPolicy;
  }

  throw new ApplicationError(
    "BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID",
    "batch_create_versions previousCurrentPolicy 仅支持 leave_as_is 或 require_complete_or_close",
    {
      receivedPreviousCurrentPolicy: previousCurrentPolicy ?? null,
      allowedPreviousCurrentPolicies: [...BATCH_PREVIOUS_CURRENT_POLICIES]
    }
  );
};

const DEFAULT_BATCH_PREVIOUS_CURRENT_POLICY: BatchPreviousCurrentPolicy = "leave_as_is";

const normalizeBatchText = (value: string | undefined): string => value?.trim() ?? "";

const normalizeBatchRef = (value: string | null | undefined): string | null => {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
};

const buildBatchPreviewVersionId = (index: number, clientKey: string): string =>
  `batch-preview:${index}:${clientKey}`;

const buildBatchSummary = (
  requestedCount: number,
  issues: BatchCreateVersionsIssue[]
): BatchCreateVersionsPlanSummary => {
  const invalidIndexes = new Set(issues.filter((issue) => issue.index >= 0).map((issue) => issue.index));
  const invalidCount = invalidIndexes.size === 0 && issues.length > 0 ? 1 : invalidIndexes.size;

  return {
    requestedCount,
    validCount: Math.max(0, requestedCount - invalidIndexes.size),
    invalidCount
  };
};

const buildBatchSuggestion = (code: string): string => {
  switch (code) {
    case "MISSING_REQUIRED_FIELD":
      return "补齐缺失字段后重试。";
    case "PROJECT_VERSION_MISMATCH":
      return "改用同一 parent 和 sibling 链内的锚点。";
    case "INVALID_VERSION_TRANSITION":
      return "仅允许在顶层 close 尾节点后做 append-only 续接；其他 close 锚点仍不可插入、重排或新增 child。请检查锚点和 parent。";
    case "VERSION_NOT_FOUND":
      return "确认引用的 version id 仍存在于当前 project。";
    case "PARTIAL_NOT_SUPPORTED":
      return "删除 partialAllowed=true；Batch B 只支持原子批量创建。";
    case "SET_CURRENT_TARGET_INVALID":
      return "把 setCurrentTo 改为某个已声明 item 的 clientKey。";
    default:
      return "检查输入 plan 与当前 route 状态后重试。";
  }
};

const buildBatchIssue = (
  index: number,
  clientKey: string,
  target: string,
  code: string,
  message: string,
  details?: Record<string, unknown>
): BatchCreateVersionsIssue => ({
  index,
  clientKey,
  target,
  code,
  message,
  suggestion: buildBatchSuggestion(code),
  details
});

const requireBatchVersion = (
  snapshot: ProjectAggregateSnapshot,
  versionId: string
) => {
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

type SanitizedBatchItem = Required<Pick<BatchCreateVersionsItemInput, "clientKey" | "title" | "description">> & {
  initialTodos: string[];
};

export type BatchCreateVersionsEvaluationSuccess = {
  ok: true;
  normalizedPlan: BatchCreateVersionsNormalizedPlan;
  resolvedAnchors: BatchCreateVersionsResolvedAnchors;
  preview: BatchCreateVersionsPreview;
  risks: BatchCreateVersionsNotice[];
  blockers: BatchCreateVersionsNotice[];
  payload: PendingOperationPayload;
};

const buildBatchPreview = (
  items: BatchCreateVersionsNormalizedItem[],
  setCurrentTo: string | null
): BatchCreateVersionsPreview => ({
  createdVersions: items.map((item) => ({
    clientKey: item.clientKey,
    previewVersionId: item.previewVersionId,
    title: item.title,
    description: item.description,
    parentVersionId: item.parentVersionId,
    previousRef: item.previousRef,
    nextRef: item.nextRef
  })),
  createdTodos: items.flatMap((item) =>
    item.initialTodos.map((title) => ({
      versionClientKey: item.clientKey,
      previewVersionId: item.previewVersionId,
      title
    }))
  ),
  setCurrentTo
});

const evaluateBatchCurrentPolicy = (
  snapshot: ProjectAggregateSnapshot,
  setCurrentTo: string | null,
  previousCurrentPolicy: BatchPreviousCurrentPolicy
): {
  risks: BatchCreateVersionsNotice[];
  blockers: BatchCreateVersionsNotice[];
} => {
  if (setCurrentTo === null || snapshot.project.currentVersionId === null) {
    return {
      risks: [],
      blockers: []
    };
  }

  const currentVersion = requireBatchVersion(snapshot, snapshot.project.currentVersionId);
  const details = {
    currentVersionId: currentVersion.id,
    currentVersionState: currentVersion.state,
    previousCurrentPolicy,
    setCurrentTo
  };

  if (
    previousCurrentPolicy === "require_complete_or_close" &&
    currentVersion.state !== "complete" &&
    currentVersion.state !== "close"
  ) {
    return {
      risks: [],
      blockers: [
        {
          code: "PREVIOUS_CURRENT_NOT_COMPLETE_OR_CLOSE",
          message: "旧 current version 未 complete/close，当前 policy 不允许直接切换 current 指针。",
          details
        }
      ]
    };
  }

  if (currentVersion.state !== "close") {
    return {
      risks: [
        {
          code: "PREVIOUS_CURRENT_LEFT_AS_IS",
          message: "旧 current version 会保持原状态；本批不会隐式 suspend 或 close 旧 current。",
          details
        }
      ],
      blockers: []
    };
  }

  return {
    risks: [],
    blockers: []
  };
};

export const evaluateBatchCreateVersions = (
  snapshot: ProjectAggregateSnapshot,
  input: EvaluateBatchCreateVersionsInput,
  evaluatedAt: string,
  preflightSnapshotHash: string
): BatchCreateVersionsFailure | BatchCreateVersionsEvaluationSuccess => {
  const issues: BatchCreateVersionsIssue[] = [];
  const requestedCount = input.items.length;
  const normalizedAnchor: BatchCreateVersionsAnchor = {
    parentVersionId: normalizeBatchRef(input.anchor?.parentVersionId),
    afterVersionId: normalizeBatchRef(input.anchor?.afterVersionId),
    beforeVersionId: normalizeBatchRef(input.anchor?.beforeVersionId)
  };
  const previousCurrentPolicy =
    assertBatchPreviousCurrentPolicy(input.previousCurrentPolicy) ??
    DEFAULT_BATCH_PREVIOUS_CURRENT_POLICY;
  const sanitizedItems: SanitizedBatchItem[] = [];
  const clientKeys = new Set<string>();

  if (input.partialAllowed === true) {
    issues.push(
      buildBatchIssue(
        -1,
        "*",
        "plan",
        "PARTIAL_NOT_SUPPORTED",
        "Batch B 不支持 partialAllowed=true。"
      )
    );
  }

  if (requestedCount === 0) {
    issues.push(
      buildBatchIssue(-1, "*", "items", "MISSING_REQUIRED_FIELD", "items 至少需要包含一个 version。")
    );
  }

  input.items.forEach((item, index) => {
    const clientKey = normalizeBatchText(item.clientKey);
    const title = normalizeBatchText(item.title);
    const hasDescription = Object.prototype.hasOwnProperty.call(item, "description");
    const hasInitialTodos = Object.prototype.hasOwnProperty.call(item, "initialTodos");
    const description = hasDescription ? normalizeBatchText(item.description) : "";
    const rawTodos = hasInitialTodos ? item.initialTodos : undefined;
    const initialTodos = Array.isArray(rawTodos)
      ? rawTodos.map((todo) => normalizeBatchText(todo))
      : [];

    if (clientKey.length === 0) {
      issues.push(
        buildBatchIssue(index, "", "version", "MISSING_REQUIRED_FIELD", "clientKey 不能为空。")
      );
    } else if (clientKeys.has(clientKey)) {
      issues.push(
        buildBatchIssue(
          index,
          clientKey,
          "version",
          "INVALID_VERSION_TRANSITION",
          "clientKey 不允许重复。"
        )
      );
    } else {
      clientKeys.add(clientKey);
    }

    if (title.length === 0) {
      issues.push(buildBatchIssue(index, clientKey, "version", "MISSING_REQUIRED_FIELD", "title 不能为空。"));
    }

    if (!hasDescription) {
      issues.push(
        buildBatchIssue(
          index,
          clientKey,
          "version",
          "MISSING_REQUIRED_FIELD",
          "description 字段必须显式提供。"
        )
      );
    }

    if (!hasInitialTodos) {
      issues.push(
        buildBatchIssue(
          index,
          clientKey,
          "initial_todos",
          "MISSING_REQUIRED_FIELD",
          "initialTodos 字段必须显式提供，可为空数组。"
        )
      );
    } else if (!Array.isArray(rawTodos)) {
      issues.push(
        buildBatchIssue(
          index,
          clientKey,
          "initial_todos",
          "MISSING_REQUIRED_FIELD",
          "initialTodos 必须是数组。"
        )
      );
    }

    initialTodos.forEach((todoTitle, todoIndex) => {
      if (todoTitle.length === 0) {
        issues.push(
          buildBatchIssue(
            index,
            clientKey,
            "initial_todo",
            "MISSING_REQUIRED_FIELD",
            `initialTodos[${todoIndex}] 不能为空。`
          )
        );
      }
    });

    sanitizedItems.push({
      clientKey,
      title,
      description,
      initialTodos
    });
  });

  if (issues.length > 0) {
    return {
      ok: false,
      code: "BATCH_VERSION_PLAN_INVALID",
      summary: buildBatchSummary(requestedCount, issues),
      issues,
      risks: [],
      blockers: []
    };
  }

  let plannedVersions = snapshot.versions.slice().sort((left, right) => left.order - right.order);
  let previousRef = normalizedAnchor.afterVersionId ?? null;
  const beforeRef = normalizedAnchor.beforeVersionId ?? null;
  const normalizedItems: BatchCreateVersionsNormalizedItem[] = [];
  let resolvedParentVersionId = normalizedAnchor.parentVersionId ?? null;

  for (let index = 0; index < sanitizedItems.length; index += 1) {
    const item = sanitizedItems[index]!;
    const previewVersionId = buildBatchPreviewVersionId(index, item.clientKey);
    const actionType =
      resolvedParentVersionId === null && previousRef === null && beforeRef === null
        ? "create_version"
        : resolvedParentVersionId === null
          ? "insert_version"
          : "create_child_version";
    const payload: PendingOperationPayload = {
      title: item.title,
      description: item.description,
      previousVersionId: previousRef,
      nextVersionId: beforeRef
    };

    if (resolvedParentVersionId !== null) {
      payload.parentVersionId = resolvedParentVersionId;
    }

    try {
      const normalizedPayload = normalizeVersionTreePayload({
        versions: plannedVersions,
        actionType,
        targetId: previewVersionId,
        payload
      });

      resolvedParentVersionId = normalizedPayload.parentVersionId ?? null;
      plannedVersions = applyVersionTreeMutation({
        projectId: snapshot.project.id,
        versions: plannedVersions,
        actionType,
        targetId: previewVersionId,
        payload: normalizedPayload,
        actor: snapshot.project.createdBy,
        now: evaluatedAt
      }).versions;
      normalizedItems.push({
        index,
        clientKey: item.clientKey,
        previewVersionId,
        title: item.title,
        description: item.description,
        parentVersionId: normalizedPayload.parentVersionId ?? null,
        previousRef: normalizedPayload.previousVersionId ?? null,
        nextRef: normalizedPayload.nextVersionId ?? null,
        initialTodos: item.initialTodos
      });
      previousRef = previewVersionId;
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code: unknown }).code === "string"
          ? (error as { code: string }).code
          : "BATCH_VERSION_PLAN_INVALID";
      const message =
        error instanceof Error ? error.message : "批量 version plan 校验失败。";
      const details =
        typeof error === "object" &&
        error !== null &&
        "details" in error &&
        typeof (error as { details: unknown }).details === "object"
          ? ((error as { details: Record<string, unknown> }).details ?? undefined)
          : undefined;
      issues.push(buildBatchIssue(index, item.clientKey, "version", code, message, details));
      break;
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: "BATCH_VERSION_PLAN_INVALID",
      summary: buildBatchSummary(requestedCount, issues),
      issues,
      risks: [],
      blockers: []
    };
  }

  const setCurrentTo = normalizeBatchRef(input.setCurrentTo);

  if (snapshot.versions.length === 0 && setCurrentTo === null) {
    issues.push(
      buildBatchIssue(
        -1,
        "project-root",
        "setCurrentTo",
        "SET_CURRENT_TARGET_INVALID",
        "空路线创建首批 Version 时必须用 setCurrentTo 明确首个 current Version。"
      )
    );
  }

  if (
    setCurrentTo !== null &&
    !normalizedItems.some(
      (item) => item.clientKey === setCurrentTo || item.previewVersionId === setCurrentTo
    )
  ) {
    issues.push(
      buildBatchIssue(
        -1,
        setCurrentTo,
        "setCurrentTo",
        "SET_CURRENT_TARGET_INVALID",
        "setCurrentTo 必须引用某个新建 item 的 clientKey。"
      )
    );
  }

  if (issues.length > 0) {
    return {
      ok: false,
      code: "BATCH_VERSION_PLAN_INVALID",
      summary: buildBatchSummary(requestedCount, issues),
      issues,
      risks: [],
      blockers: []
    };
  }

  const resolvedAnchors: BatchCreateVersionsResolvedAnchors = {
    parentVersionId: resolvedParentVersionId,
    afterVersionId: normalizedAnchor.afterVersionId ?? null,
    beforeVersionId: normalizedAnchor.beforeVersionId ?? null
  };
  const normalizedPlan: BatchCreateVersionsNormalizedPlan = {
    partialAllowed: false,
    anchor: normalizedAnchor,
    items: normalizedItems,
    setCurrentTo,
    previousCurrentPolicy
  };
  const preview = buildBatchPreview(normalizedItems, setCurrentTo);
  const { risks, blockers } = evaluateBatchCurrentPolicy(
    snapshot,
    setCurrentTo,
    previousCurrentPolicy
  );
  const payload: PendingOperationPayload = {
    batchItems: sanitizedItems.map((item) => ({
      clientKey: item.clientKey,
      title: item.title,
      description: item.description,
      initialTodos: item.initialTodos
    })),
    batchAnchor: normalizedAnchor,
    batchNormalizedPlan: normalizedItems,
    batchResolvedAnchors: resolvedAnchors,
    batchSetCurrentTo: setCurrentTo,
    batchPreviousCurrentPolicy: previousCurrentPolicy,
    batchPreflightSnapshotHash: preflightSnapshotHash
  };
  return {
    ok: true,
    normalizedPlan,
    resolvedAnchors,
    preview,
    risks,
    blockers,
    payload
  };
};
