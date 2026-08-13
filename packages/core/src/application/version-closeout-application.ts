import type { ProjectAggregateSnapshot } from "../ports/storage-port.js";

import { ApplicationError } from "./errors.js";
import {
  buildVersionCloseoutPlan,
  type VersionCloseoutPlan
} from "./version-closeout-planner.js";
import {
  clampCloseoutEventLimit,
  collectVersionCloseoutView,
  type VersionCloseoutSummary,
  type VersionCloseoutView
} from "./version-closeout-query.js";

export interface SummarizeVersionCloseoutInput {
  projectId: string;
  versionId?: string;
  eventLimit?: number;
}

export interface PlanVersionCloseoutInput {
  projectId: string;
  versionId?: string;
  eventLimit?: number;
}

type CloseoutApplicationResult<T> = {
  data: T;
  meta: Record<string, unknown>;
};

const collectRequestedVersionCloseoutView = (
  snapshot: ProjectAggregateSnapshot,
  input: SummarizeVersionCloseoutInput | PlanVersionCloseoutInput
): VersionCloseoutView => {
  const versionId = input.versionId ?? snapshot.project.currentVersionId;

  if (versionId === null) {
    throw new ApplicationError("VERSION_NOT_FOUND", "project 当前没有 current version", {
      projectId: input.projectId
    });
  }

  return collectVersionCloseoutView({
    snapshot,
    versionId,
    eventLimit: clampCloseoutEventLimit(input.eventLimit)
  });
};

export const summarizeVersionCloseoutApplication = (
  snapshot: ProjectAggregateSnapshot,
  input: SummarizeVersionCloseoutInput
): CloseoutApplicationResult<VersionCloseoutSummary> => {
  const closeoutView = collectRequestedVersionCloseoutView(snapshot, input);
  return {
    data: closeoutView.summary,
    meta: closeoutView.meta
  };
};

export const planVersionCloseoutApplication = (
  snapshot: ProjectAggregateSnapshot,
  input: PlanVersionCloseoutInput
): CloseoutApplicationResult<VersionCloseoutPlan> => {
  const closeoutView = collectRequestedVersionCloseoutView(snapshot, input);
  return {
    data: buildVersionCloseoutPlan(closeoutView),
    meta: closeoutView.meta
  };
};
