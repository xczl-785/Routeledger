import type { StoragePort } from "../ports/storage-port.js";

import { ApplicationError } from "./errors.js";
import { loadRequiredProjectAggregate } from "./project-aggregate-access.js";
import type { PendingOperation } from "./types.js";

type L3ProposalReader = Pick<StoragePort, "loadProjectAggregate">;

export interface L3ProposalReadUseCases {
  listL3Proposals(projectId: string): Promise<PendingOperation[]>;
  getL3Proposal(projectId: string, pendingOperationId: string): Promise<PendingOperation>;
}

export class L3ProposalReadService implements L3ProposalReadUseCases {
  private readonly storage: L3ProposalReader;

  constructor(options: { storage: L3ProposalReader }) {
    this.storage = options.storage;
  }

  async listL3Proposals(projectId: string): Promise<PendingOperation[]> {
    const snapshot = await loadRequiredProjectAggregate(this.storage, projectId);

    return snapshot.pendingOperations
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async getL3Proposal(
    projectId: string,
    pendingOperationId: string
  ): Promise<PendingOperation> {
    const snapshot = await loadRequiredProjectAggregate(this.storage, projectId);
    const proposal = snapshot.pendingOperations.find(
      (operation) => operation.id === pendingOperationId
    );

    if (proposal === undefined) {
      throw new ApplicationError("PENDING_OPERATION_NOT_FOUND", "pending operation 不存在", {
        projectId,
        pendingOperationId
      });
    }

    return proposal;
  }
}
