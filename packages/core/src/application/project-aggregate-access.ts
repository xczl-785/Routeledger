import {
  type ProjectAggregateSnapshot,
  type ProjectSnapshotReader,
  type ProjectSnapshotWriter
} from "../ports/storage-port.js";

import { ApplicationError } from "./errors.js";

export type { ProjectSnapshotReader, ProjectSnapshotWriter } from "../ports/storage-port.js";

export const cloneProjectAggregateSnapshot = (
  snapshot: ProjectAggregateSnapshot
): ProjectAggregateSnapshot => {
  return structuredClone(snapshot);
};

export const loadRequiredProjectAggregate = async (
  storage: ProjectSnapshotReader,
  projectId: string
): Promise<ProjectAggregateSnapshot> => {
  const snapshot = await storage.loadProjectAggregate(projectId);

  if (snapshot === null) {
    throw new ApplicationError("PROJECT_NOT_FOUND", "project 不存在", { projectId });
  }

  if (snapshot.project.id !== projectId) {
    throw new ApplicationError(
      "PROJECT_OWNERSHIP_MISMATCH",
      "storage 返回的 project 与请求 project 不一致",
      { projectId, actualProjectId: snapshot.project.id }
    );
  }

  return cloneProjectAggregateSnapshot(snapshot);
};

export const persistProjectAggregate = async (
  storage: ProjectSnapshotWriter,
  snapshot: ProjectAggregateSnapshot
): Promise<void> => {
  if (snapshot.project.settings.contentLocale === null) {
    throw new ApplicationError(
      "CONTENT_LOCALE_REQUIRED",
      "Project content_locale is null. Confirm and set a concrete locale before writing project state.",
      { projectId: snapshot.project.id }
    );
  }

  snapshot.headRevision = await storage.saveProjectAggregate(snapshot);
};
