import type { ProjectAggregateSnapshot } from "@routeledger/core";

import {
  buildProjectAggregateReviewSummary,
  type ProjectAggregateReviewSummary
} from "./review-summary.js";

export interface AuditDiffFile {
  path: string;
  addedLines: number | null;
  deletedLines: number | null;
}

export interface ProjectAuditSummary {
  overview: {
    baseRef: string;
    headRef: string;
    projectId: string;
    logicalOperationCount: number;
    auditDocumentCountAdded: number;
  };
  operations: {
    byCommand: Record<string, number>;
    byEventType: Record<string, number>;
  };
  physical: {
    changedFileCount: number;
    addedLines: number;
    deletedLines: number;
    binaryFileCount: number;
    byArea: Record<string, number>;
  };
  semantic: ProjectAggregateReviewSummary;
  summaryText: string;
}

const countBy = (values: string[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const value of values.sort((left, right) => left.localeCompare(right, "en"))) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
};

const areaForPath = (filePath: string): string => {
  const segments = filePath.replaceAll("\\", "/").split("/");
  const routeLedgerIndex = segments.indexOf(".routeledger");
  const entry = segments[routeLedgerIndex + 1] ?? "root";
  return entry.endsWith(".json") ? "root" : entry;
};

export const buildProjectAuditSummary = (
  base: ProjectAggregateSnapshot,
  head: ProjectAggregateSnapshot,
  diffFiles: AuditDiffFile[],
  labels: { baseRef: string; headRef: string }
): ProjectAuditSummary => {
  const baseEventIds = new Set(base.events.map((event) => event.id));
  const addedEvents = head.events.filter((event) => !baseEventIds.has(event.id));
  const baseReceiptIds = new Set((base.ordinaryWriteReceipts ?? []).map((receipt) => receipt.id));
  const addedReceipts = (head.ordinaryWriteReceipts ?? []).filter(
    (receipt) => !baseReceiptIds.has(receipt.id)
  );
  const operationIds = new Set(addedEvents.map((event) => event.operationId));
  const auditDocumentCountAdded =
    addedEvents.length +
    addedReceipts.length +
    head.pendingOperations.filter((item) => !base.pendingOperations.some((baseItem) => baseItem.id === item.id)).length +
    head.approvalArtifacts.filter((item) => !base.approvalArtifacts.some((baseItem) => baseItem.id === item.id)).length;
  const physicalAreas = countBy(diffFiles.map((file) => areaForPath(file.path)));
  const semantic = buildProjectAggregateReviewSummary(base, head, {
    baseLabel: labels.baseRef,
    headLabel: labels.headRef
  });
  const addedLines = diffFiles.reduce((sum, file) => sum + (file.addedLines ?? 0), 0);
  const deletedLines = diffFiles.reduce((sum, file) => sum + (file.deletedLines ?? 0), 0);

  const commandNames: string[] = addedReceipts.map((receipt) => receipt.commandName);
  const receiptOperationIds = new Set<string>();
  for (const receipt of addedReceipts) {
    const events = Array.isArray(receipt.result.events) ? receipt.result.events : [];
    for (const event of events) {
      if (typeof event === "object" && event !== null && "operationId" in event &&
          typeof event.operationId === "string") {
        receiptOperationIds.add(event.operationId);
      }
    }
  }
  const eventsByOperation = new Map<string, string[]>();
  for (const event of addedEvents) {
    const eventTypes = eventsByOperation.get(event.operationId) ?? [];
    eventTypes.push(event.eventType);
    eventsByOperation.set(event.operationId, eventTypes);
  }
  const inferredCommands: Array<[string, string]> = [
    ["todo.created", "create_todo"],
    ["todo.closed", "close_todo"],
    ["deferred.created", "defer_work"],
    ["deferred.reviewed", "review_deferred"],
    ["constraint.created", "record_constraint"],
    ["constraint.retired", "retire_constraint"]
  ];
  for (const [operationId, eventTypes] of eventsByOperation) {
    if (receiptOperationIds.has(operationId)) continue;
    const inferred = inferredCommands.find(([eventType]) => eventTypes.includes(eventType));
    if (inferred !== undefined) commandNames.push(inferred[1]);
  }

  return {
    overview: {
      ...labels,
      projectId: head.project.id,
      logicalOperationCount: operationIds.size,
      auditDocumentCountAdded
    },
    operations: {
      byCommand: countBy(commandNames),
      byEventType: countBy(addedEvents.map((event) => event.eventType))
    },
    physical: {
      changedFileCount: diffFiles.length,
      addedLines,
      deletedLines,
      binaryFileCount: diffFiles.filter((file) => file.addedLines === null).length,
      byArea: physicalAreas
    },
    semantic,
    summaryText:
      `${labels.baseRef} -> ${labels.headRef}: ${operationIds.size} logical operations, ` +
      `${auditDocumentCountAdded} added audit records, ${diffFiles.length} changed files ` +
      `(+${addedLines}/-${deletedLines} lines).`
  };
};
