import type { ClockPort } from "../ports/clock-port.js";

import { ApplicationError } from "./errors.js";
import {
  loadRequiredProjectAggregate,
  type ProjectSnapshotReader
} from "./project-aggregate-access.js";
import {
  buildBalancedL3AuthorizationPolicy,
  type L3AuthorizationEvaluationContext,
  type L3AuthorizationPolicy
} from "./l3-authorization.js";
import type { PendingOperation } from "./types.js";

export interface GetL3AuthorizationEvaluationContextInput {
  projectId: string;
  pendingOperationId: string;
  routeledgerRootDigest: string;
  profileId?: string;
  modeEpoch?: number;
  profileDigest?: string;
  subjectId?: string;
  hostKind?: string;
  clientId?: string;
}

export interface RecommendBalancedL3AuthorizationPolicyInput {
  projectId: string;
  policyId: string;
  routeledgerRootDigest: string;
  expiresAt: string;
  decisionBudget: number;
  subjectId?: string;
  hostKind?: string;
  clientId?: string;
}

export interface L3ProposalReadUseCases {
  listL3Proposals(projectId: string): Promise<PendingOperation[]>;
  getL3Proposal(projectId: string, pendingOperationId: string): Promise<PendingOperation>;
  getL3AuthorizationEvaluationContext(
    input: GetL3AuthorizationEvaluationContextInput
  ): Promise<L3AuthorizationEvaluationContext>;
  recommendBalancedL3AuthorizationPolicy(
    input: RecommendBalancedL3AuthorizationPolicyInput
  ): Promise<L3AuthorizationPolicy>;
}

const requireL3Proposal = (
  snapshot: Awaited<ReturnType<typeof loadRequiredProjectAggregate>>,
  pendingOperationId: string
): PendingOperation => {
  const proposal = snapshot.pendingOperations.find(
    (operation) => operation.id === pendingOperationId
  );

  if (proposal === undefined) {
    throw new ApplicationError("PENDING_OPERATION_NOT_FOUND", "pending operation 不存在", {
      projectId: snapshot.project.id,
      pendingOperationId
    });
  }

  return proposal;
};

export class L3ProposalReadService implements L3ProposalReadUseCases {
  private readonly storage: ProjectSnapshotReader;

  private readonly clock: ClockPort;

  constructor(options: { storage: ProjectSnapshotReader; clock: ClockPort }) {
    this.storage = options.storage;
    this.clock = options.clock;
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
    return requireL3Proposal(snapshot, pendingOperationId);
  }

  async getL3AuthorizationEvaluationContext(
    input: GetL3AuthorizationEvaluationContextInput
  ): Promise<L3AuthorizationEvaluationContext> {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    const proposal = requireL3Proposal(snapshot, input.pendingOperationId);
    const currentVersion = snapshot.versions.find(
      (version) => version.id === snapshot.project.currentVersionId
    );
    const targetRelation =
      proposal.targetId === snapshot.project.currentVersionId
        ? "current"
        : currentVersion?.nextVersionId === proposal.targetId
          ? "legal-successor"
          : "other";

    return {
      projectId: input.projectId,
      routeledgerRootDigest: input.routeledgerRootDigest,
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      ...(input.modeEpoch === undefined ? {} : { modeEpoch: input.modeEpoch }),
      ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
      actionType: proposal.actionType,
      targetId: proposal.targetId,
      currentVersionId: snapshot.project.currentVersionId,
      targetRelation,
      gateAllowed: proposal.gateSnapshot.allowed,
      operationDigest: proposal.digest.value,
      now: this.clock.now(),
      ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
      ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
      ...(input.clientId === undefined ? {} : { clientId: input.clientId })
    };
  }

  async recommendBalancedL3AuthorizationPolicy(
    input: RecommendBalancedL3AuthorizationPolicyInput
  ): Promise<L3AuthorizationPolicy> {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);

    return buildBalancedL3AuthorizationPolicy({
      policyId: input.policyId,
      projectId: input.projectId,
      routeledgerRootDigest: input.routeledgerRootDigest,
      currentVersionId: snapshot.project.currentVersionId,
      routeVersionIds: snapshot.versions.map((version) => version.id),
      expiresAt: input.expiresAt,
      decisionBudget: input.decisionBudget,
      ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
      ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
      ...(input.clientId === undefined ? {} : { clientId: input.clientId })
    });
  }
}
