import type { RouteLedgerToolRiskLevel, ToolResponse } from "./registry/tool-contract.js";

export type AgentResponseDetail = "compact" | "standard" | "audit";

export interface AgentResponseDetailContext {
  detail: AgentResponseDetail;
  explicit: boolean;
  toolName: string;
  operation?: string;
  riskLevel: RouteLedgerToolRiskLevel;
}

const MAX_COMPACT_ARRAY_ITEMS = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const estimateBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const definedEntries = (
  entries: Array<readonly [string, unknown]>
): Record<string, unknown> =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined));

const compactRuntimeData = (
  value: unknown,
  omittedSections: Set<string>
): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;

  const binding = isRecord(value.binding) ? value.binding : null;
  const activeProject = isRecord(value.activeProject) ? value.activeProject : null;
  const contentLocale = isRecord(value.contentLocale) ? value.contentLocale : null;
  const missionControl = isRecord(value.missionControl) ? value.missionControl : null;
  const notice = missionControl !== null && isRecord(missionControl.notice)
    ? missionControl.notice
    : null;
  const advisoryAction = missionControl !== null && isRecord(missionControl.advisoryAction)
    ? missionControl.advisoryAction
    : null;
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
  const blockedTools = Array.isArray(value.blockedTools) ? value.blockedTools : [];
  const recommendedNextActions = Array.isArray(value.recommendedNextActions)
    ? value.recommendedNextActions
    : [];

  for (const key of [
    "processCwd",
    "runtimeProfile",
    "runtimeIdentity",
    "actor",
    "approver",
    "storage"
  ]) {
    if (value[key] !== undefined) omittedSections.add(`data.${key}`);
  }
  if (binding !== null && Object.keys(binding).length > 2) {
    omittedSections.add("data.binding[nonessential]");
  }
  if (activeProject !== null && Object.keys(activeProject).length > 4) {
    omittedSections.add("data.activeProject[nonessential]");
  }
  if (contentLocale !== null && Object.keys(contentLocale).length > 3) {
    omittedSections.add("data.contentLocale[nonessential]");
  }
  if (missionControl !== null) {
    omittedSections.add("data.missionControl[nonessential]");
  }

  return definedEntries([
    [
      "binding",
      binding === null
        ? undefined
        : definedEntries([
            ["status", binding.status],
            ["routeledgerRoot", binding.routeledgerRoot]
          ])
    ],
    ["hostProfile", value.hostProfile],
    ["interactionProfile", value.interactionProfile],
    [
      "activeProject",
      activeProject === null
        ? value.activeProject === null
          ? null
          : undefined
        : definedEntries([
            ["id", activeProject.id],
            ["name", activeProject.name],
            ["currentVersionId", activeProject.currentVersionId],
            ["contentLocale", activeProject.contentLocale]
          ])
    ],
    [
      "contentLocale",
      contentLocale === null
        ? undefined
        : definedEntries([
            ["status", contentLocale.status],
            ["configuredValue", contentLocale.configuredValue],
            ["requiresUserDecision", contentLocale.requiresUserDecision]
          ])
    ],
    [
      "missionControl",
      missionControl === null
        ? undefined
        : definedEntries([
            ["status", missionControl.status],
            [
              "notice",
              notice === null
                ? undefined
                : definedEntries([
                    ["code", notice.code],
                    ["message", notice.message],
                    ["requiresUserDecision", notice.requiresUserDecision]
                  ])
            ],
            [
              "advisoryAction",
              advisoryAction === null
                ? undefined
                : definedEntries([
                    ["tool", advisoryAction.tool],
                    ["arguments", advisoryAction.arguments],
                    ["requiresUserDecision", advisoryAction.requiresUserDecision]
                  ])
            ],
            ["recommendationLevel", missionControl.recommendationLevel]
          ])
    ],
    ["diagnostics", diagnostics.length === 0 ? undefined : diagnostics],
    ["blockedTools", blockedTools.length === 0 ? undefined : blockedTools],
    [
      "recommendedNextActions",
      recommendedNextActions.length === 0 ? undefined : recommendedNextActions
    ]
  ]);
};

const compactRuntimeContext = (
  value: Record<string, unknown>,
  path: string,
  omittedSections: Set<string>
): Record<string, unknown> => {
  const binding = isRecord(value.binding) ? value.binding : null;
  const activeProject = isRecord(value.activeProject) ? value.activeProject : null;
  const retainedRuntimeKeys = new Set(["binding", "projectId", "hostProfile", "activeProject"]);
  if (Object.keys(value).some((key) => !retainedRuntimeKeys.has(key))) {
    omittedSections.add(`${path}[nonessential]`);
  }
  if (binding !== null) {
    if (Object.keys(binding).some((key) => key !== "status" && key !== "routeledgerRoot")) {
      omittedSections.add(`${path}.binding[nonessential]`);
    }
  }
  if (activeProject !== null) {
    if (Object.keys(activeProject).some((key) => key !== "id" && key !== "name")) {
      omittedSections.add(`${path}.activeProject[nonessential]`);
    }
  }
  return {
    ...(binding === null
      ? {}
      : {
          binding: {
            ...(typeof binding.status === "string" ? { status: binding.status } : {}),
            ...(typeof binding.routeledgerRoot === "string"
              ? { routeledgerRoot: binding.routeledgerRoot }
              : {})
          }
        }),
    ...(typeof value.projectId === "string" || value.projectId === null
      ? { projectId: value.projectId }
      : {}),
    ...(typeof value.hostProfile === "string" ? { hostProfile: value.hostProfile } : {}),
    ...(activeProject === null
      ? {}
      : {
          activeProject: {
            ...(typeof activeProject.id === "string" ? { id: activeProject.id } : {}),
            ...(typeof activeProject.name === "string" ? { name: activeProject.name } : {})
          }
        })
  };
};

const compactEvent = (
  value: unknown,
  path: string,
  omittedSections: Set<string>
): unknown => {
  if (!isRecord(value)) return value;
  const retainedKeys = new Set([
    "id",
    "type",
    "eventType",
    "createdAt",
    "occurredAt",
    "timestamp"
  ]);
  for (const key of Object.keys(value)) {
    if (!retainedKeys.has(key)) omittedSections.add(`${path}.${key}`);
  }
  return Object.fromEntries(
    [...retainedKeys]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]])
  );
};

const COMPACT_ROUTE_RECORD_FIELDS = new Set([
  "id",
  "projectId",
  "actionType",
  "targetId",
  "status",
  "reason",
  "rejectionReason",
  "digest",
  "approvalArtifactId",
  "pendingOperationId",
  "authorizationId",
  "operationDigest",
  "createdAt",
  "updatedAt",
  "authorizedAt",
  "committedAt",
  "expiresAt",
  "gate",
  "replayed"
]);

const compactRouteRecord = (
  value: Record<string, unknown>,
  path: string,
  omittedSections: Set<string>
): Record<string, unknown> => {
  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (COMPACT_ROUTE_RECORD_FIELDS.has(key)) {
      compact[key] = projectCompactValue(child, `${path}.${key}`, omittedSections, key);
    } else {
      omittedSections.add(`${path}.${key}`);
    }
  }
  return compact;
};

const compactProjectSummary = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return definedEntries([
    ["id", value.id],
    ["name", value.name],
    ["status", value.status],
    ["currentVersionId", value.currentVersionId],
    ["contentLocale", value.contentLocale]
  ]);
};

const compactVersionSummary = (value: unknown): unknown => {
  if (value === null || !isRecord(value)) return value;
  return definedEntries([
    ["id", value.id],
    ["title", value.title],
    ["state", value.state],
    ["displayState", value.displayState],
    ["stateReason", value.stateReason],
    ["order", value.order],
    ["isCurrent", value.isCurrent]
  ]);
};

const compactTodoSummary = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return definedEntries([
    ["id", value.id],
    ["projectId", value.projectId],
    ["workItemId", value.workItemId],
    ["versionId", value.versionId],
    ["title", value.title],
    ["status", value.status],
    ["closeReason", value.closeReason]
  ]);
};

const compactIdempotency = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return definedEntries([
    ["protected", value.protected],
    ["receiptId", value.receiptId],
    ["replayed", value.replayed],
    ["resultScope", value.resultScope],
    ["originalCommittedAt", value.originalCommittedAt],
    ["currentStateRefreshed", value.currentStateRefreshed],
    ["recommendedNextAction", value.recommendedNextAction]
  ]);
};

const compactTodoWriteData = (
  value: unknown,
  omittedSections: Set<string>
): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  if (value.workItem !== undefined) omittedSections.add("data.workItem");
  return definedEntries([
    ["todo", compactTodoSummary(value.todo)],
    [
      "events",
      Array.isArray(value.events)
        ? value.events.map((item) => compactEvent(item, "data.events[]", omittedSections))
        : value.events
    ],
    ["idempotency", compactIdempotency(value.idempotency)]
  ]);
};

const compactDeferredSummary = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return definedEntries([
    ["id", value.id],
    ["title", value.title],
    ["status", value.status],
    ["targetReviewVersionId", value.targetReviewVersionId],
    ["reason", value.reason],
    ["reviewTrigger", value.reviewTrigger]
  ]);
};

const compactConstraintSummary = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  return definedEntries([
    ["id", value.id],
    ["rule", value.rule],
    ["scope", value.scope],
    ["status", value.status]
  ]);
};

const compactGate = (value: unknown): unknown => {
  if (value === null || !isRecord(value)) return value;
  return definedEntries([
    ["kind", value.kind],
    ["versionId", value.versionId],
    ["allowed", value.allowed],
    ["blockers", value.blockers],
    ["blockerCount", value.blockerCount]
  ]);
};

const compactNextAction = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const executable = isRecord(value.toolInput) || typeof value.recommendedTool === "string";
  return definedEntries([
    ["actionType", value.actionType],
    ["recommendedTool", value.recommendedTool],
    ["tool", value.tool],
    ["toolInput", value.toolInput],
    ["targetId", value.targetId],
    ["pendingOperationId", value.pendingOperationId],
    ["approvalArtifactId", value.approvalArtifactId],
    ["operationDigest", value.operationDigest],
    ["requiresL3Approval", value.requiresL3Approval],
    ["requiresUserDecision", value.requiresUserDecision],
    [
      "blockingRiskCodes",
      Array.isArray(value.blockingRiskCodes) && value.blockingRiskCodes.length === 0
        ? undefined
        : value.blockingRiskCodes
    ],
    [
      "recordIds",
      Array.isArray(value.recordIds) && value.recordIds.length === 0
        ? undefined
        : value.recordIds
    ],
    [
      "choices",
      Array.isArray(value.choices) && value.choices.length === 0
        ? undefined
        : value.choices
    ],
    ["summary", executable ? undefined : value.summary],
    ["reason", executable ? undefined : value.reason]
  ]);
};

const mapArray = (
  value: unknown,
  projector: (item: unknown) => unknown
): unknown => Array.isArray(value) ? value.map(projector) : value;

const mapNonEmptyArray = (
  value: unknown,
  projector: (item: unknown) => unknown
): unknown => Array.isArray(value) && value.length === 0
  ? undefined
  : mapArray(value, projector);

const compactNextActionData = (
  value: unknown,
  omittedSections: Set<string>
): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).some(
      (key) => !["project", "currentVersion", "nextVersion", "nextAction"].includes(key)
    )
  ) {
    omittedSections.add("data.routeContextExceptAction");
  }
  return definedEntries([
    ["project", compactProjectSummary(value.project)],
    ["currentVersion", compactVersionSummary(value.currentVersion)],
    ["nextVersion", compactVersionSummary(value.nextVersion)],
    ["nextAction", compactNextAction(value.nextAction)]
  ]);
};

const compactCurrentContextData = (
  value: unknown,
  omittedSections: Set<string>
): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  omittedSections.add("data.entityDescriptionsAndTimestamps");
  const currentVersion = isRecord(value.currentVersion) ? value.currentVersion : null;
  const nextVersion = isRecord(value.nextVersion) ? value.nextVersion : null;
  const routeWindow = Array.isArray(value.versions)
    ? value.versions.filter(
        (item) =>
          !isRecord(item) ||
          (item.id !== currentVersion?.id && item.id !== nextVersion?.id)
      )
    : value.versions;
  const nextAction = isRecord(value.nextAction) ? value.nextAction : null;
  const gates = isRecord(value.gates) ? value.gates : null;
  const relevantGates = gates === null
    ? value.gates
    : nextAction?.actionType === "start_version"
      ? { start: compactGate(gates.start) }
      : nextAction?.actionType === "close_version"
        ? { close: compactGate(gates.close) }
        : {
            start: compactGate(gates.start),
            close: compactGate(gates.close)
          };
  return definedEntries([
    ["project", compactProjectSummary(value.project)],
    ["currentVersion", compactVersionSummary(value.currentVersion)],
    ["nextVersion", compactVersionSummary(value.nextVersion)],
    ["versions", mapNonEmptyArray(routeWindow, compactVersionSummary)],
    ["todos", mapNonEmptyArray(value.todos, compactTodoSummary)],
    ["currentTodos", mapNonEmptyArray(value.currentTodos, compactTodoSummary)],
    ["deferred", mapNonEmptyArray(value.deferred, compactDeferredSummary)],
    ["constraints", mapNonEmptyArray(value.constraints, compactConstraintSummary)],
    ["dueDeferred", mapNonEmptyArray(value.dueDeferred, compactDeferredSummary)],
    ["dueDeferredIds", mapNonEmptyArray(value.dueDeferredIds, (item) => item)],
    [
      "unresolvedDeferredIds",
      mapNonEmptyArray(value.unresolvedDeferredIds, (item) => item)
    ],
    [
      "blockedConstraintIds",
      mapNonEmptyArray(value.blockedConstraintIds, (item) => item)
    ],
    ["gates", relevantGates],
    [
      "pendingL3Proposals",
      Array.isArray(value.pendingL3Proposals) && value.pendingL3Proposals.length > 0
        ? value.pendingL3Proposals.map((item) =>
            isRecord(item)
              ? compactRouteRecord(item, "data.pendingL3Proposals[]", omittedSections)
              : item
          )
        : undefined
    ],
    ["statusRisks", mapNonEmptyArray(value.statusRisks, (item) => item)],
    ["nextAction", compactNextAction(value.nextAction)],
    ["legacyUndo", value.legacyUndo]
  ]);
};

const compactOperationMeta = (
  value: unknown,
  context: AgentResponseDetailContext,
  omittedSections: Set<string>
): unknown => {
  if (!isRecord(value)) return value;
  const runtimeContext = isRecord(value.runtimeContext)
    ? compactRuntimeContext(value.runtimeContext, "meta.runtimeContext", omittedSections)
    : undefined;
  const isFocusedRead =
    (context.toolName === "inspect_runtime" && context.operation === "runtime") ||
    (context.toolName === "inspect_route_progress" &&
      ["next_action", "get_current_context"].includes(context.operation ?? ""));
  if (!isFocusedRead) {
    return projectCompactValue(value, "meta", omittedSections);
  }
  const truncated = value.truncated === true;
  return definedEntries([
    ["runtimeContext", runtimeContext],
    ["truncated", truncated ? true : undefined],
    ["budgetBytes", truncated ? value.budgetBytes : undefined],
    ["contextHasMore", truncated ? value.hasMore : undefined],
    [
      "truncatedFields",
      truncated && Array.isArray(value.truncatedFields) && value.truncatedFields.length > 0
        ? value.truncatedFields
        : undefined
    ],
    [
      "omittedCounts",
      truncated && isRecord(value.omittedCounts) && Object.keys(value.omittedCounts).length > 0
        ? value.omittedCounts
        : undefined
    ]
  ]);
};

const projectCompactValue = (
  value: unknown,
  path: string,
  omittedSections: Set<string>,
  parentKey = ""
): unknown => {
  if (Array.isArray(value)) {
    const source =
      parentKey === "events"
        ? value.map((item) => compactEvent(item, `${path}[]`, omittedSections))
        : value;
    if (value.length > MAX_COMPACT_ARRAY_ITEMS) {
      omittedSections.add(`${path}[${MAX_COMPACT_ARRAY_ITEMS}:]`);
    }
    return source
      .slice(0, MAX_COMPACT_ARRAY_ITEMS)
      .map((item) => projectCompactValue(item, `${path}[]`, omittedSections));
  }
  if (!isRecord(value)) return value;
  if (parentKey === "runtimeContext") {
    return compactRuntimeContext(value, path, omittedSections);
  }
  if (
    ["proposal", "pendingOperation", "rejection", "approvalArtifact"].includes(parentKey)
  ) {
    return compactRouteRecord(value, path, omittedSections);
  }

  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "payload" && !path.includes("recommendedNextActions")) {
      omittedSections.add(`${path}.payload`);
      continue;
    }
    compact[key] = projectCompactValue(child, `${path}.${key}`, omittedSections, key);
  }
  return compact;
};

const collectEntityIds = (value: unknown, ids: Set<string>): void => {
  if (ids.size >= 16) return;
  if (Array.isArray(value)) {
    for (const child of value) collectEntityIds(child, ids);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string" &&
      (key === "id" || key === "proposalId" || key === "pendingOperationId" || key === "targetId" || /Id$/u.test(key))
    ) {
      ids.add(child);
    } else if (key !== "recommendedNextActions") {
      collectEntityIds(child, ids);
    }
  }
};

const inferDeltaKind = (operation: string | undefined, riskLevel: RouteLedgerToolRiskLevel) => {
  if (riskLevel === "read-only") return "read";
  if (operation !== undefined && /(?:create|initialize|record|propose|defer)/u.test(operation)) {
    return "created";
  }
  return "updated";
};

const buildCompactData = (
  data: unknown,
  context: AgentResponseDetailContext,
  omittedSections: Set<string>
): unknown => {
  if (context.toolName === "inspect_runtime" && context.operation === "runtime") {
    return compactRuntimeData(data, omittedSections) ?? data;
  }
  if (
    context.toolName === "inspect_route_progress" &&
    context.operation === "next_action"
  ) {
    return compactNextActionData(data, omittedSections) ?? data;
  }
  if (
    context.toolName === "inspect_route_progress" &&
    context.operation === "get_current_context"
  ) {
    return compactCurrentContextData(data, omittedSections) ?? data;
  }
  if (
    context.toolName === "inspect_versions" &&
    ["list_versions", "list_versions_window"].includes(context.operation ?? "")
  ) {
    return projectCompactValue(data, "data", omittedSections);
  }
  if (
    context.toolName === "inspect_l3_route_operations" &&
    context.operation === "list_l3_proposals"
  ) {
    return Array.isArray(data)
      ? data.map((item) =>
          isRecord(item)
            ? compactRouteRecord(item, "data[]", omittedSections)
            : item
        )
      : data;
  }
  if (
    context.toolName === "manage_todo" &&
    ["create", "close"].includes(context.operation ?? "")
  ) {
    return compactTodoWriteData(data, omittedSections) ?? data;
  }

  const projected = projectCompactValue(data, "data", omittedSections);
  const record = isRecord(projected) ? projected : { items: projected };
  const entityIds = new Set<string>();
  collectEntityIds(record, entityIds);
  const status =
    [record.status, record.state, record.mode].find((value) => typeof value === "string") ??
    "succeeded";
  const primaryId =
    [record.proposalId, record.pendingOperationId, record.id, record.targetId]
      .find((value) => typeof value === "string") ??
    [...entityIds][0];

  return {
    ...record,
    agentSummary: {
      outcome: status,
      tool: context.toolName,
      ...(context.operation === undefined ? {} : { operation: context.operation }),
      ...(primaryId === undefined ? {} : { primaryId })
    },
    delta: {
      kind: inferDeltaKind(context.operation, context.riskLevel),
      entityIds: [...entityIds]
    }
  };
};

export const parseAgentResponseDetail = (value: unknown): AgentResponseDetail | null =>
  value === "compact" || value === "standard" || value === "audit" ? value : null;

export const applyAgentResponseDetail = <T extends ToolResponse>(
  response: T,
  context: AgentResponseDetailContext
): T => {
  if (context.detail === "standard" && !context.explicit) return response;

  if (context.detail === "audit" || context.detail === "standard") {
    const measured = response.data ?? response.error ?? null;
    return {
      ...response,
      meta: {
        ...(response.meta ?? {}),
        detailApplied: context.detail,
        payloadBytes: estimateBytes(measured),
        hasMore: false,
        omittedSections: []
      }
    } as T;
  }

  const omittedSections = new Set<string>();
  const data = response.data === undefined
    ? undefined
    : buildCompactData(response.data, context, omittedSections);
  const error = response.error === undefined
    ? undefined
    : projectCompactValue(response.error, "error", omittedSections);
  const projectedMeta = compactOperationMeta(response.meta ?? {}, context, omittedSections);
  const measured = data ?? error ?? null;
  return {
    ...response,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
    meta: {
      ...(isRecord(projectedMeta) ? projectedMeta : {}),
      detailApplied: "compact",
      payloadBytes: estimateBytes(measured),
      hasMore: omittedSections.size > 0,
      omittedSections: [...omittedSections].sort()
    }
  } as T;
};
