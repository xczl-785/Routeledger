import type { Version } from "../domain/version.js";
import {
  attachProjectAggregateHeadRevision,
  getProjectAggregateHeadRevision,
  type ProjectAggregateSnapshot,
  type StoragePort
} from "../ports/storage-port.js";

import {
  buildCurrentContextResult,
  buildNextActionResult,
  buildVersionsWindowResult
} from "./current-context-query.js";
import { ApplicationError } from "./errors.js";

export interface ListVersionsWindowQueryInput {
  projectId: string;
  aroundVersionId?: string;
  before?: number;
  after?: number;
}

export interface CurrentContextQueryInput {
  projectId: string;
  budgetBytes?: number;
  includeAllVersions?: boolean;
  versionWindowBefore?: number;
  versionWindowAfter?: number;
  includeLegacyUndo?: boolean;
}

export interface RouteLedgerVersionQueryUseCases {
  listVersions(projectId: string): Promise<Version[]>;
  listVersionsWindow(input: ListVersionsWindowQueryInput): Promise<ReturnType<typeof buildVersionsWindowResult>>;
  getCurrentContext(input: CurrentContextQueryInput): Promise<ReturnType<typeof buildCurrentContextResult>>;
  getNextAction(input: CurrentContextQueryInput): Promise<ReturnType<typeof buildNextActionResult>>;
}

type ProjectSnapshotReader = Pick<StoragePort, "loadProjectAggregate">;

const cloneSnapshot = (snapshot: ProjectAggregateSnapshot): ProjectAggregateSnapshot => {
  const cloned = structuredClone(snapshot);
  const headRevision = getProjectAggregateHeadRevision(snapshot);

  return headRevision === undefined
    ? cloned
    : attachProjectAggregateHeadRevision(cloned, headRevision);
};

const loadRequiredProject = async (
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

  return cloneSnapshot(snapshot);
};

export class RouteLedgerQueryService implements RouteLedgerVersionQueryUseCases {
  private readonly storage: ProjectSnapshotReader;

  constructor(options: { storage: ProjectSnapshotReader }) {
    this.storage = options.storage;
  }

  async listVersions(projectId: string): Promise<Version[]> {
    const snapshot = await loadRequiredProject(this.storage, projectId);

    return snapshot.versions.slice().sort((left, right) => left.order - right.order);
  }

  async listVersionsWindow(input: ListVersionsWindowQueryInput) {
    const snapshot = await loadRequiredProject(this.storage, input.projectId);
    return buildVersionsWindowResult(snapshot, input);
  }

  async getCurrentContext(input: CurrentContextQueryInput) {
    const snapshot = await loadRequiredProject(this.storage, input.projectId);
    return buildCurrentContextResult(snapshot, input);
  }

  async getNextAction(input: CurrentContextQueryInput) {
    const snapshot = await loadRequiredProject(this.storage, input.projectId);
    return buildNextActionResult(snapshot, input);
  }
}
