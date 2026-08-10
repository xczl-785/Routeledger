import { isDeepStrictEqual } from "node:util";

import type { L3ActionType } from "./types.js";
import type { L3AuthorizationScope } from "./l3-authorization.js";

export type L3AuthorizationGrantStatus = "active" | "revoked" | "exhausted";
export type L3AuthorizationGrantSource =
  | "user_interaction"
  | "delegated_policy"
  | "preauthorized";

export interface L3AuthorizationGrant {
  id: string;
  issuer: string;
  subjectId: string;
  audience: string;
  projectId: string;
  routeledgerRootDigest: string;
  allowedActions: L3ActionType[];
  allowedTargetIds: string[];
  operationDigest: string | null;
  scope: L3AuthorizationScope;
  source: L3AuthorizationGrantSource;
  policyId: string | null;
  policyDigest: string | null;
  decisionId: string;
  hostKind: string;
  clientId: string | null;
  sessionId: string | null;
  nonce: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  status: L3AuthorizationGrantStatus;
  revokedAt: string | null;
}

export interface L3AuthorizationGrantContext {
  audience: string;
  subjectId: string;
  projectId: string;
  routeledgerRootDigest: string;
  actionType: L3ActionType;
  targetId: string;
  operationDigest: string;
  now: string;
  hostKind: string;
  clientId?: string;
  sessionId?: string;
}

export type L3AuthorizationGrantFailureCode =
  | "GRANT_NOT_FOUND"
  | "GRANT_INACTIVE"
  | "GRANT_EXPIRED"
  | "GRANT_EXHAUSTED"
  | "GRANT_AUDIENCE_MISMATCH"
  | "GRANT_SUBJECT_MISMATCH"
  | "GRANT_PROJECT_MISMATCH"
  | "GRANT_ROOT_MISMATCH"
  | "GRANT_ACTION_MISMATCH"
  | "GRANT_TARGET_MISMATCH"
  | "GRANT_OPERATION_MISMATCH"
  | "GRANT_HOST_MISMATCH"
  | "GRANT_CLIENT_MISMATCH"
  | "GRANT_SESSION_MISMATCH";

export interface L3AuthorizationGrantConsumption {
  ok: true;
  grant: L3AuthorizationGrant;
  consumedUse: number;
}

export interface L3AuthorizationGrantFailure {
  ok: false;
  code: L3AuthorizationGrantFailureCode;
}

export type L3AuthorizationGrantConsumeResult =
  | L3AuthorizationGrantConsumption
  | L3AuthorizationGrantFailure;

export interface L3AuthorizationReceiptBinding {
  approvalArtifactId: string;
  pendingOperationId: string;
  grantId: string;
  audience: string;
  subjectId: string;
  projectId: string;
  routeledgerRootDigest: string;
  actionType: L3ActionType;
  targetId: string;
  operationDigest: string;
  approvalSource: L3AuthorizationGrantSource | undefined;
  decisionRef: string;
  approverId: string;
  approverType: "user" | "agent" | "system";
  approverDisplayName: string | undefined;
  policyId: string | null | undefined;
  policyDigest: string | null | undefined;
  hostKind: string | undefined;
  clientId: string | null | undefined;
  sessionId: string | null | undefined;
  createdAt: string;
  expiresAt: string;
}

export interface L3AuthorizationConsumptionReceipt extends L3AuthorizationReceiptBinding {
  consumedUse: number;
}

export interface L3AuthorizationGrantConsumptionWithReceipt
  extends L3AuthorizationGrantConsumption {
  receipt: L3AuthorizationConsumptionReceipt;
}

export type L3AuthorizationGrantConsumeWithReceiptResult =
  | L3AuthorizationGrantConsumptionWithReceipt
  | L3AuthorizationGrantFailure;

export interface L3ConsumedAuthorizationReplay {
  grant: L3AuthorizationGrant;
  receipt: L3AuthorizationConsumptionReceipt;
}

export interface L3AuthorizationGrantStore {
  issue(grant: L3AuthorizationGrant): Promise<void>;
  get(grantId: string): Promise<L3AuthorizationGrant | null>;
  findMatching(context: L3AuthorizationGrantContext): Promise<L3AuthorizationGrant | null>;
  consume(
    grantId: string,
    context: L3AuthorizationGrantContext
  ): Promise<L3AuthorizationGrantConsumeResult>;
  consumeAndRecordReceipt(
    grantId: string,
    context: L3AuthorizationGrantContext,
    pendingOperationId: string,
    createReceipt: (
      consumption: L3AuthorizationGrantConsumption
    ) => L3AuthorizationConsumptionReceipt
  ): Promise<L3AuthorizationGrantConsumeWithReceiptResult>;
  findConsumedAuthorization(
    context: L3AuthorizationGrantContext,
    pendingOperationId: string
  ): Promise<L3ConsumedAuthorizationReplay | null>;
  recordConsumptionReceipt(receipt: L3AuthorizationConsumptionReceipt): Promise<void>;
  verifyConsumptionReceipt(binding: L3AuthorizationReceiptBinding): Promise<boolean>;
  revoke(grantId: string, revokedAt: string): Promise<L3AuthorizationGrant | null>;
}

const cloneGrant = (grant: L3AuthorizationGrant): L3AuthorizationGrant => ({
  ...grant,
  allowedActions: [...grant.allowedActions],
  allowedTargetIds: [...grant.allowedTargetIds]
});

const receiptMatchesAuthorizationContext = (
  receipt: L3AuthorizationConsumptionReceipt,
  grantId: string,
  context: L3AuthorizationGrantContext,
  pendingOperationId: string
): boolean =>
  receipt.grantId === grantId &&
  receipt.pendingOperationId === pendingOperationId &&
  receipt.audience === context.audience &&
  receipt.subjectId === context.subjectId &&
  receipt.projectId === context.projectId &&
  receipt.routeledgerRootDigest === context.routeledgerRootDigest &&
  receipt.actionType === context.actionType &&
  receipt.targetId === context.targetId &&
  receipt.operationDigest === context.operationDigest &&
  receipt.hostKind === context.hostKind &&
  (receipt.clientId == null || receipt.clientId === context.clientId) &&
  (receipt.sessionId == null || receipt.sessionId === context.sessionId);

const validateCreatedReceipt = (
  receipt: L3AuthorizationConsumptionReceipt,
  grantId: string,
  context: L3AuthorizationGrantContext,
  pendingOperationId: string,
  consumedUse: number
): void => {
  if (
    !receiptMatchesAuthorizationContext(
      receipt,
      grantId,
      context,
      pendingOperationId
    ) ||
    receipt.consumedUse !== consumedUse ||
    receipt.approvalArtifactId.trim().length === 0 ||
    receipt.pendingOperationId.trim().length === 0
  ) {
    throw new Error("L3 authorization consumption receipt does not match the consumed grant.");
  }
};

export const validateL3AuthorizationGrant = (
  grant: L3AuthorizationGrant,
  context: L3AuthorizationGrantContext
): L3AuthorizationGrantFailureCode | null => {
  if (grant.status !== "active") return "GRANT_INACTIVE";
  if (Date.parse(context.now) >= Date.parse(grant.expiresAt)) return "GRANT_EXPIRED";
  if (grant.uses >= grant.maxUses) return "GRANT_EXHAUSTED";
  if (grant.audience !== context.audience) return "GRANT_AUDIENCE_MISMATCH";
  if (grant.subjectId !== context.subjectId) return "GRANT_SUBJECT_MISMATCH";
  if (grant.projectId !== context.projectId) return "GRANT_PROJECT_MISMATCH";
  if (grant.routeledgerRootDigest !== context.routeledgerRootDigest) return "GRANT_ROOT_MISMATCH";
  if (!grant.allowedActions.includes(context.actionType)) return "GRANT_ACTION_MISMATCH";
  if (!grant.allowedTargetIds.includes(context.targetId)) return "GRANT_TARGET_MISMATCH";
  if (grant.operationDigest !== null && grant.operationDigest !== context.operationDigest) {
    return "GRANT_OPERATION_MISMATCH";
  }
  if (grant.scope === "operation" && grant.operationDigest === null) {
    return "GRANT_OPERATION_MISMATCH";
  }
  if (grant.hostKind !== context.hostKind) return "GRANT_HOST_MISMATCH";
  if (grant.clientId !== null && grant.clientId !== context.clientId) {
    return "GRANT_CLIENT_MISMATCH";
  }
  if (grant.sessionId !== null && grant.sessionId !== context.sessionId) {
    return "GRANT_SESSION_MISMATCH";
  }
  return null;
};

export class MemoryL3AuthorizationGrantStore implements L3AuthorizationGrantStore {
  private readonly grants = new Map<string, L3AuthorizationGrant>();
  private readonly receipts = new Map<string, L3AuthorizationConsumptionReceipt>();

  async issue(grant: L3AuthorizationGrant): Promise<void> {
    const existing = this.grants.get(grant.id);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, grant)) return;
      throw new Error(`L3 authorization grant already exists: ${grant.id}`);
    }
    this.grants.set(grant.id, cloneGrant(grant));
  }

  async get(grantId: string): Promise<L3AuthorizationGrant | null> {
    const grant = this.grants.get(grantId);
    return grant === undefined ? null : cloneGrant(grant);
  }

  async findMatching(context: L3AuthorizationGrantContext): Promise<L3AuthorizationGrant | null> {
    const matches = [...this.grants.values()]
      .filter((grant) => validateL3AuthorizationGrant(grant, context) === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return matches[0] === undefined ? null : cloneGrant(matches[0]);
  }

  async consume(
    grantId: string,
    context: L3AuthorizationGrantContext
  ): Promise<L3AuthorizationGrantConsumeResult> {
    const grant = this.grants.get(grantId);
    if (grant === undefined) return { ok: false, code: "GRANT_NOT_FOUND" };

    const failure = validateL3AuthorizationGrant(grant, context);
    if (failure !== null) return { ok: false, code: failure };

    const consumedUse = grant.uses + 1;
    const updated: L3AuthorizationGrant = {
      ...grant,
      uses: consumedUse,
      status: consumedUse >= grant.maxUses ? "exhausted" : "active"
    };
    this.grants.set(grantId, updated);

    return { ok: true, grant: cloneGrant(updated), consumedUse };
  }

  async consumeAndRecordReceipt(
    grantId: string,
    context: L3AuthorizationGrantContext,
    pendingOperationId: string,
    createReceipt: (
      consumption: L3AuthorizationGrantConsumption
    ) => L3AuthorizationConsumptionReceipt
  ): Promise<L3AuthorizationGrantConsumeWithReceiptResult> {
    const replayReceipt = [...this.receipts.values()].find((receipt) =>
      receiptMatchesAuthorizationContext(receipt, grantId, context, pendingOperationId)
    );
    if (replayReceipt !== undefined) {
      const replayGrant = this.grants.get(grantId);
      if (replayGrant === undefined) return { ok: false, code: "GRANT_NOT_FOUND" };
      return {
        ok: true,
        grant: cloneGrant(replayGrant),
        consumedUse: replayReceipt.consumedUse,
        receipt: structuredClone(replayReceipt)
      };
    }

    const grant = this.grants.get(grantId);
    if (grant === undefined) return { ok: false, code: "GRANT_NOT_FOUND" };
    const failure = validateL3AuthorizationGrant(grant, context);
    if (failure !== null) return { ok: false, code: failure };
    const consumedUse = grant.uses + 1;
    const updated: L3AuthorizationGrant = {
      ...grant,
      uses: consumedUse,
      status: consumedUse >= grant.maxUses ? "exhausted" : "active"
    };
    const consumption: L3AuthorizationGrantConsumption = {
      ok: true,
      grant: cloneGrant(updated),
      consumedUse
    };
    const receipt = createReceipt(consumption);
    validateCreatedReceipt(receipt, grantId, context, pendingOperationId, consumedUse);
    if (this.receipts.has(receipt.approvalArtifactId)) {
      throw new Error(
        `L3 authorization consumption receipt already exists: ${receipt.approvalArtifactId}`
      );
    }
    this.grants.set(grantId, updated);
    this.receipts.set(receipt.approvalArtifactId, structuredClone(receipt));
    return { ...consumption, receipt: structuredClone(receipt) };
  }

  async findConsumedAuthorization(
    context: L3AuthorizationGrantContext,
    pendingOperationId: string
  ): Promise<L3ConsumedAuthorizationReplay | null> {
    const receipt = [...this.receipts.values()].find((candidate) =>
      receiptMatchesAuthorizationContext(
        candidate,
        candidate.grantId,
        context,
        pendingOperationId
      )
    );
    if (receipt === undefined) return null;
    const grant = this.grants.get(receipt.grantId);
    if (grant === undefined) return null;
    return { grant: cloneGrant(grant), receipt: structuredClone(receipt) };
  }

  async recordConsumptionReceipt(receipt: L3AuthorizationConsumptionReceipt): Promise<void> {
    const existing = this.receipts.get(receipt.approvalArtifactId);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing, receipt)) return;
      throw new Error(
        `L3 authorization consumption receipt already exists: ${receipt.approvalArtifactId}`
      );
    }
    this.receipts.set(receipt.approvalArtifactId, structuredClone(receipt));
  }

  async verifyConsumptionReceipt(binding: L3AuthorizationReceiptBinding): Promise<boolean> {
    const receipt = this.receipts.get(binding.approvalArtifactId);
    if (receipt === undefined) return false;
    return (
      receipt.consumedUse > 0 &&
      Object.entries(binding).every(
        ([key, value]) =>
          receipt[key as keyof L3AuthorizationConsumptionReceipt] === value
      )
    );
  }

  async revoke(grantId: string, revokedAt: string): Promise<L3AuthorizationGrant | null> {
    const grant = this.grants.get(grantId);
    if (grant === undefined) return null;
    const updated: L3AuthorizationGrant = {
      ...grant,
      status: "revoked",
      revokedAt
    };
    this.grants.set(grantId, updated);
    return cloneGrant(updated);
  }
}
