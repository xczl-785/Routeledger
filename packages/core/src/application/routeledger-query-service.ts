import type { Version } from "../domain/version.js";

import {
  buildCurrentContextResult,
  buildNextActionResult,
  buildVersionsWindowResult
} from "./current-context-query.js";
import {
  loadRequiredProjectAggregate,
  type ProjectSnapshotReader
} from "./project-aggregate-access.js";
import {
  planVersionCloseoutApplication,
  summarizeVersionCloseoutApplication,
  type PlanVersionCloseoutInput,
  type SummarizeVersionCloseoutInput
} from "./version-closeout-application.js";

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
  summarizeVersionCloseout(
    input: SummarizeVersionCloseoutInput
  ): Promise<ReturnType<typeof summarizeVersionCloseoutApplication>>;
  planVersionCloseout(
    input: PlanVersionCloseoutInput
  ): Promise<ReturnType<typeof planVersionCloseoutApplication>>;
}

export class RouteLedgerQueryService implements RouteLedgerVersionQueryUseCases {
  private readonly storage: ProjectSnapshotReader;

  constructor(options: { storage: ProjectSnapshotReader }) {
    this.storage = options.storage;
  }

  async listVersions(projectId: string): Promise<Version[]> {
    const snapshot = await loadRequiredProjectAggregate(this.storage, projectId);

    return snapshot.versions.slice().sort((left, right) => left.order - right.order);
  }

  async listVersionsWindow(input: ListVersionsWindowQueryInput) {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    return buildVersionsWindowResult(snapshot, input);
  }

  async getCurrentContext(input: CurrentContextQueryInput) {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    return buildCurrentContextResult(snapshot, input);
  }

  async getNextAction(input: CurrentContextQueryInput) {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    return buildNextActionResult(snapshot, input);
  }

  async summarizeVersionCloseout(input: SummarizeVersionCloseoutInput) {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    return summarizeVersionCloseoutApplication(snapshot, input);
  }

  async planVersionCloseout(input: PlanVersionCloseoutInput) {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    return planVersionCloseoutApplication(snapshot, input);
  }
}
