import type { Actor } from "../domain/actor.js";
import { createDomainContext, type DomainDependencies } from "../services/operation.js";
import { createTransitionEvents } from "../services/transition-event-service.js";

import { ApplicationError } from "./errors.js";
import type {
  ExactAuthorizationBinding,
  ExactAuthorizationCandidate,
  ExactAuthorizationReceiptBinding
} from "./exact-authorization-contract.js";
import type { ExactAuthorizationStore } from "./exact-authorization-store.js";
import {
  loadRequiredProjectAggregate,
  persistProjectAggregate,
  type ProjectSnapshotReader,
  type ProjectSnapshotWriter
} from "./project-aggregate-access.js";
import type { ApprovalArtifact, PendingOperation } from "./types.js";

import crypto from "node:crypto";

export interface AuthorizeL3OperationInput {
  projectId: string;
  pendingOperationId: string;
  authorizationId: string;
  actor: Actor;
}

export interface TrustedL3AuthorizationControlPlane {
  exactStore: ExactAuthorizationStore;
  routeledgerRootDigest: string;
  profileId?: string;
  modeEpoch?: number;
  profileDigest?: string;
}

export interface L3ExactAuthorizationUseCases {
  authorizeL3Operation(input: AuthorizeL3OperationInput): Promise<ApprovalArtifact>;
}

type L3ExactAuthorizationStorage = ProjectSnapshotReader & ProjectSnapshotWriter;

export const buildAuthorizationCommitClaimId = (
  artifact: ApprovalArtifact,
  pendingOperation: PendingOperation
): string =>
  `commit_${crypto
    .createHash("sha256")
    .update(`${artifact.id}\0${pendingOperation.id}\0${pendingOperation.digest.value}`, "utf8")
    .digest("hex")}`;

export const buildExactAuthorizationBinding = (
  pendingOperation: PendingOperation,
  routeledgerRootDigest: string
): ExactAuthorizationBinding => ({
  proposalId: pendingOperation.id,
  projectId: pendingOperation.projectId,
  routeledgerRootDigest,
  actionType: pendingOperation.actionType,
  targetId: pendingOperation.targetId,
  operationDigest: pendingOperation.digest.value
});

export const buildExactReceiptBinding = (
  candidate: ExactAuthorizationCandidate,
  artifactId: string
): ExactAuthorizationReceiptBinding => ({
  authorizationId: candidate.authorizationId,
  artifactId,
  binding: candidate.binding,
  issuer: candidate.issuer,
  audience: candidate.audience,
  subjectId: candidate.subjectId,
  source: candidate.source,
  decisionRef: candidate.decisionRef,
  policyId: candidate.policyId,
  policyDigest: candidate.policyDigest,
  profileId: candidate.profileId,
  modeEpoch: candidate.modeEpoch,
  profileDigest: candidate.profileDigest,
  hostKind: candidate.hostKind,
  clientId: candidate.clientId,
  createdAt: candidate.createdAt,
  expiresAt: candidate.expiresAt
});

export const hasV2AuthorizationProfile = (artifact: ApprovalArtifact): boolean =>
  artifact.profileId !== undefined &&
  artifact.modeEpoch !== undefined &&
  artifact.profileDigest !== undefined;

export const getExactArtifactReceiptBinding = async (input: {
  artifact: ApprovalArtifact;
  pendingOperation: PendingOperation;
  controlPlane: TrustedL3AuthorizationControlPlane | null;
}): Promise<ExactAuthorizationReceiptBinding | null> => {
  if (input.controlPlane === null || input.artifact.authorizationId === undefined) return null;

  const expected = buildExactAuthorizationBinding(
    input.pendingOperation,
    input.controlPlane.routeledgerRootDigest
  );
  const candidate = await input.controlPlane.exactStore.get(input.artifact.authorizationId);
  if (candidate === null) return null;
  if (
    candidate.binding.proposalId !== expected.proposalId ||
    candidate.binding.projectId !== expected.projectId ||
    candidate.binding.routeledgerRootDigest !== expected.routeledgerRootDigest ||
    candidate.binding.actionType !== expected.actionType ||
    candidate.binding.targetId !== expected.targetId ||
    candidate.binding.operationDigest !== expected.operationDigest ||
    input.artifact.decisionRef !== candidate.decisionRef ||
    input.artifact.approvalSource !== candidate.source ||
    input.artifact.policyId !== candidate.policyId ||
    input.artifact.policyDigest !== candidate.policyDigest ||
    (input.artifact.profileId ?? null) !== candidate.profileId ||
    (input.artifact.modeEpoch ?? null) !== candidate.modeEpoch ||
    (input.artifact.profileDigest ?? null) !== candidate.profileDigest ||
    input.artifact.hostKind !== candidate.hostKind ||
    input.artifact.clientId !== candidate.clientId ||
    input.artifact.createdAt !== candidate.createdAt ||
    input.artifact.expiresAt !== candidate.expiresAt ||
    input.artifact.approver.id !== candidate.subjectId
  ) {
    return null;
  }
  return buildExactReceiptBinding(candidate, input.artifact.id);
};

const requirePendingOperation = (
  snapshot: Awaited<ReturnType<typeof loadRequiredProjectAggregate>>,
  pendingOperationId: string
): PendingOperation => {
  const pendingOperation = snapshot.pendingOperations.find((item) => item.id === pendingOperationId);
  if (pendingOperation === undefined) {
    throw new ApplicationError("PENDING_OPERATION_NOT_FOUND", "pending operation 不存在", {
      projectId: snapshot.project.id,
      pendingOperationId
    });
  }
  return pendingOperation;
};

const appendRecord = <T extends { id: string }>(records: T[], nextRecord: T): T[] =>
  records.some((record) => record.id === nextRecord.id)
    ? records.map((record) => (record.id === nextRecord.id ? nextRecord : record))
    : records.concat(nextRecord);

const approverForExactAuthorization = (candidate: ExactAuthorizationCandidate): Actor => ({
  id: candidate.subjectId,
  type:
    candidate.source === "delegated_policy" || candidate.source === "host_admission"
      ? "system"
      : "user",
  displayName:
    candidate.source === "delegated_policy"
      ? "RouteLedger deterministic policy"
      : candidate.source === "host_admission"
        ? "Codex native tool admission"
        : candidate.subjectId
});

export class L3ExactAuthorizationService implements L3ExactAuthorizationUseCases {
  constructor(
    private readonly options: {
      storage: L3ExactAuthorizationStorage;
      deps: DomainDependencies;
      controlPlane: TrustedL3AuthorizationControlPlane | null;
    }
  ) {}

  async authorizeL3Operation(input: AuthorizeL3OperationInput): Promise<ApprovalArtifact> {
    const controlPlane = this.options.controlPlane;
    if (controlPlane === null) {
      throw new ApplicationError(
        "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
        "L3 trusted authorization control plane is not configured",
        { pendingOperationId: input.pendingOperationId }
      );
    }

    const snapshot = await loadRequiredProjectAggregate(this.options.storage, input.projectId);
    const pendingOperation = requirePendingOperation(snapshot, input.pendingOperationId);
    if (pendingOperation.status !== "pending") {
      throw new ApplicationError(
        "PENDING_OPERATION_NOT_PENDING",
        "pending operation 不是待授权状态",
        { pendingOperationId: pendingOperation.id, status: pendingOperation.status }
      );
    }

    const binding = buildExactAuthorizationBinding(
      pendingOperation,
      controlPlane.routeledgerRootDigest
    );
    const existingArtifact = snapshot.approvalArtifacts.find(
      (artifact) =>
        artifact.pendingOperationId === pendingOperation.id &&
        artifact.authorizationId === input.authorizationId &&
        artifact.status === "approved"
    );
    if (existingArtifact !== undefined) {
      const existingBinding = await getExactArtifactReceiptBinding({
        artifact: existingArtifact,
        pendingOperation,
        controlPlane
      });
      if (existingBinding !== null && (await controlPlane.exactStore.verifyReceipt(existingBinding))) {
        return existingArtifact;
      }
    }

    const now = this.options.deps.clock.now();
    const exactCandidate = await controlPlane.exactStore.get(input.authorizationId);
    if (exactCandidate === null) {
      throw new ApplicationError(
        "EXACT_AUTHORIZATION_REJECTED",
        "No trusted exact authorization is registered for this proposal",
        {
          pendingOperationId: pendingOperation.id,
          authorizationId: input.authorizationId,
          reason: "EXACT_AUTHORIZATION_REQUIRED"
        }
      );
    }
    const existingReceipt = await controlPlane.exactStore.getReceipt(input.authorizationId);
    const artifactId = existingReceipt?.artifactId ?? this.options.deps.idGenerator.nextId();
    const consumed = await controlPlane.exactStore.consumeAndRecordReceipt({
      authorizationId: input.authorizationId,
      artifactId,
      binding,
      now
    });
    if (!consumed.ok) {
      throw new ApplicationError(
        "EXACT_AUTHORIZATION_REJECTED",
        "The exact authorization did not authorize this operation",
        {
          pendingOperationId: pendingOperation.id,
          authorizationId: input.authorizationId,
          reason: consumed.code
        }
      );
    }

    const receipt = consumed.receipt;
    const approver = approverForExactAuthorization(exactCandidate);
    const artifact: ApprovalArtifact = {
      id: receipt.artifactId,
      projectId: input.projectId,
      pendingOperationId: receipt.binding.proposalId,
      actionType: receipt.binding.actionType,
      targetId: receipt.binding.targetId,
      digest: pendingOperation.digest,
      status: "approved",
      approver,
      decisionRef: receipt.decisionRef,
      createdAt: receipt.createdAt,
      expiresAt: receipt.expiresAt,
      consumedAt: null,
      authorizationId: receipt.authorizationId,
      routeledgerRootDigest: receipt.binding.routeledgerRootDigest,
      approvalSource: receipt.source,
      policyId: receipt.policyId,
      policyDigest: receipt.policyDigest,
      ...(receipt.profileId === null ? {} : { profileId: receipt.profileId }),
      ...(receipt.modeEpoch === null ? {} : { modeEpoch: receipt.modeEpoch }),
      ...(receipt.profileDigest === null ? {} : { profileDigest: receipt.profileDigest }),
      hostKind: receipt.hostKind,
      clientId: receipt.clientId
    };

    const latestSnapshot = await loadRequiredProjectAggregate(this.options.storage, input.projectId);
    const recoveredArtifact = latestSnapshot.approvalArtifacts.find(
      (candidate) => candidate.id === artifact.id
    );
    if (recoveredArtifact !== undefined) return recoveredArtifact;
    const context = createDomainContext(this.options.deps, input.actor);
    const events = createTransitionEvents(
      [
        {
          targetType: "approval_artifact",
          targetId: artifact.id,
          eventType: "approval_artifact.authorized",
          toState: artifact.status,
          metadata: {
            pendingOperationId: pendingOperation.id,
            authorizationId: exactCandidate.authorizationId,
            approvalSource: exactCandidate.source,
            decisionRef: exactCandidate.decisionRef,
            policyId: exactCandidate.policyId,
            policyDigest: exactCandidate.policyDigest,
            profileId: exactCandidate.profileId,
            modeEpoch: exactCandidate.modeEpoch,
            profileDigest: exactCandidate.profileDigest,
            hostKind: exactCandidate.hostKind,
            clientId: exactCandidate.clientId,
            exactAuthorization: true,
            expiresAt: artifact.expiresAt,
            approverId: approver.id,
            approverType: approver.type
          }
        }
      ],
      {
        projectId: latestSnapshot.project.id,
        actor: input.actor,
        now,
        operationId: context.operationId
      },
      this.options.deps.idGenerator
    );
    latestSnapshot.approvalArtifacts = appendRecord(latestSnapshot.approvalArtifacts, artifact);
    latestSnapshot.events = latestSnapshot.events.concat(events);
    await persistProjectAggregate(this.options.storage, latestSnapshot);
    return artifact;
  }
}
