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

const compactRuntimeContext = (
  value: Record<string, unknown>,
  path: string,
  omittedSections: Set<string>
): Record<string, unknown> => {
  const binding = isRecord(value.binding) ? value.binding : null;
  const activeProject = isRecord(value.activeProject) ? value.activeProject : null;
  const retainedRuntimeKeys = new Set(["binding", "projectId", "hostProfile", "activeProject"]);
  for (const key of Object.keys(value)) {
    if (!retainedRuntimeKeys.has(key)) omittedSections.add(`${path}.${key}`);
  }
  if (binding !== null) {
    for (const key of Object.keys(binding)) {
      if (key !== "status" && key !== "routeledgerRoot") {
        omittedSections.add(`${path}.binding.${key}`);
      }
    }
  }
  if (activeProject !== null) {
    for (const key of Object.keys(activeProject)) {
      if (key !== "id" && key !== "name") {
        omittedSections.add(`${path}.activeProject.${key}`);
      }
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
  const projectedMeta = projectCompactValue(response.meta ?? {}, "meta", omittedSections);
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
