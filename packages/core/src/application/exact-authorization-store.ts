import { isDeepStrictEqual } from "node:util";

import type {
  ExactAuthorization,
  ExactAuthorizationBinding,
  ExactAuthorizationCandidate,
  ExactAuthorizationReceipt,
  ExactAuthorizationReceiptBinding
} from "./exact-authorization-contract.js";

export type ExactAuthorizationStatus = "active" | "consumed" | "revoked";

export type ExactAuthorizationFailureCode =
  | "AUTHORIZATION_NOT_FOUND"
  | "AUTHORIZATION_INACTIVE"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_BINDING_MISMATCH"
  | "AUTHORIZATION_ARTIFACT_MISMATCH"
  | "RECEIPT_NOT_FOUND"
  | "RECEIPT_BINDING_MISMATCH"
  | "RECEIPT_REVOKED"
  | "RECEIPT_CLAIMED_BY_OTHER";

export type ExactAuthorizationConsumeResult =
  | {
      readonly ok: true;
      readonly authorization: ExactAuthorization;
      readonly receipt: ExactAuthorizationReceipt;
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly code: ExactAuthorizationFailureCode };

export type ExactAuthorizationCommitResult =
  | {
      readonly ok: true;
      readonly receipt: ExactAuthorizationReceipt;
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly code: ExactAuthorizationFailureCode };

export interface ExactAuthorizationStore {
  issue(candidate: ExactAuthorizationCandidate): Promise<void>;
  get(authorizationId: string): Promise<ExactAuthorizationCandidate | null>;
  getReceipt(authorizationId: string): Promise<ExactAuthorizationReceipt | null>;
  consumeAndRecordReceipt(input: {
    readonly authorizationId: string;
    readonly artifactId: string;
    readonly binding: ExactAuthorizationBinding;
    readonly now: string;
  }): Promise<ExactAuthorizationConsumeResult>;
  verifyReceipt(binding: ExactAuthorizationReceiptBinding): Promise<boolean>;
  claimCommit(
    binding: ExactAuthorizationReceiptBinding,
    claim: { readonly claimId: string; readonly claimedAt: string }
  ): Promise<ExactAuthorizationCommitResult>;
  finalizeCommit(
    binding: ExactAuthorizationReceiptBinding,
    claimId: string,
    committedAt: string
  ): Promise<ExactAuthorizationCommitResult>;
  revoke(authorizationId: string, revokedAt: string): Promise<boolean>;
  revokeProfileReceipts(
    profileId: string,
    beforeModeEpoch: number,
    revokedAt: string
  ): Promise<number>;
}

type StoredAuthorization = {
  candidate: ExactAuthorizationCandidate;
  status: ExactAuthorizationStatus;
  artifactId: string | null;
  revokedAt: string | null;
};

const clone = <T>(value: T): T => structuredClone(value);

const requireNonEmpty = (value: string, field: string): void => {
  if (value.trim().length === 0) throw new Error(`Exact authorization ${field} is required.`);
};

const validateCandidate = (candidate: ExactAuthorizationCandidate): void => {
  requireNonEmpty(candidate.authorizationId, "authorizationId");
  requireNonEmpty(candidate.binding.proposalId, "proposalId");
  requireNonEmpty(candidate.binding.projectId, "projectId");
  requireNonEmpty(candidate.binding.routeledgerRootDigest, "routeledgerRootDigest");
  requireNonEmpty(candidate.binding.targetId, "targetId");
  requireNonEmpty(candidate.binding.operationDigest, "operationDigest");
  requireNonEmpty(candidate.issuer, "issuer");
  requireNonEmpty(candidate.audience, "audience");
  requireNonEmpty(candidate.subjectId, "subjectId");
  requireNonEmpty(candidate.decisionRef, "decisionRef");
  requireNonEmpty(candidate.hostKind, "hostKind");
  if (
    Number.isNaN(Date.parse(candidate.createdAt)) ||
    Number.isNaN(Date.parse(candidate.expiresAt)) ||
    Date.parse(candidate.expiresAt) <= Date.parse(candidate.createdAt)
  ) {
    throw new Error("Exact authorization timestamps are invalid.");
  }
  const profileCount = [candidate.profileId, candidate.modeEpoch, candidate.profileDigest]
    .filter((value) => value !== null).length;
  if (profileCount !== 0 && profileCount !== 3) {
    throw new Error("Exact authorization profile provenance must be all present or all null.");
  }
};

const bindingMatches = (
  left: ExactAuthorizationBinding,
  right: ExactAuthorizationBinding
): boolean => isDeepStrictEqual(left, right);

const receiptBindingMatches = (
  receipt: ExactAuthorizationReceipt,
  binding: ExactAuthorizationReceiptBinding
): boolean =>
  Object.entries(binding).every(
    ([key, value]) => receipt[key as keyof ExactAuthorizationReceipt] === value ||
      (typeof value === "object" && value !== null &&
        isDeepStrictEqual(receipt[key as keyof ExactAuthorizationReceipt], value))
  );

const buildReceiptBinding = (
  authorization: ExactAuthorization
): ExactAuthorizationReceiptBinding => ({
  authorizationId: authorization.authorizationId,
  artifactId: authorization.artifactId,
  binding: authorization.binding,
  issuer: authorization.issuer,
  audience: authorization.audience,
  subjectId: authorization.subjectId,
  source: authorization.source,
  decisionRef: authorization.decisionRef,
  policyId: authorization.policyId,
  policyDigest: authorization.policyDigest,
  profileId: authorization.profileId,
  modeEpoch: authorization.modeEpoch,
  profileDigest: authorization.profileDigest,
  hostKind: authorization.hostKind,
  clientId: authorization.clientId,
  createdAt: authorization.createdAt,
  expiresAt: authorization.expiresAt
});

export class MemoryExactAuthorizationStore implements ExactAuthorizationStore {
  private readonly authorizations = new Map<string, StoredAuthorization>();
  private readonly receipts = new Map<string, ExactAuthorizationReceipt>();

  async issue(candidate: ExactAuthorizationCandidate): Promise<void> {
    validateCandidate(candidate);
    const existing = this.authorizations.get(candidate.authorizationId);
    if (existing !== undefined) {
      if (isDeepStrictEqual(existing.candidate, candidate)) return;
      throw new Error(`Exact authorization already exists: ${candidate.authorizationId}`);
    }
    this.authorizations.set(candidate.authorizationId, {
      candidate: clone(candidate),
      status: "active",
      artifactId: null,
      revokedAt: null
    });
  }

  async get(authorizationId: string): Promise<ExactAuthorizationCandidate | null> {
    const stored = this.authorizations.get(authorizationId);
    return stored === undefined ? null : clone(stored.candidate);
  }

  async getReceipt(authorizationId: string): Promise<ExactAuthorizationReceipt | null> {
    const receipt = [...this.receipts.values()].find(
      (candidate) => candidate.authorizationId === authorizationId
    );
    return receipt === undefined ? null : clone(receipt);
  }

  async consumeAndRecordReceipt(input: {
    readonly authorizationId: string;
    readonly artifactId: string;
    readonly binding: ExactAuthorizationBinding;
    readonly now: string;
  }): Promise<ExactAuthorizationConsumeResult> {
    const stored = this.authorizations.get(input.authorizationId);
    if (stored === undefined) return { ok: false, code: "AUTHORIZATION_NOT_FOUND" };
    if (!bindingMatches(stored.candidate.binding, input.binding)) {
      return { ok: false, code: "AUTHORIZATION_BINDING_MISMATCH" };
    }
    if (stored.status === "revoked") return { ok: false, code: "AUTHORIZATION_INACTIVE" };
    if (stored.status === "consumed") {
      if (stored.artifactId !== input.artifactId) {
        return { ok: false, code: "AUTHORIZATION_ARTIFACT_MISMATCH" };
      }
      const receipt = this.receipts.get(input.artifactId);
      if (receipt === undefined) return { ok: false, code: "RECEIPT_NOT_FOUND" };
      return {
        ok: true,
        authorization: { ...clone(stored.candidate), artifactId: input.artifactId },
        receipt: clone(receipt),
        replayed: true
      };
    }
    if (new Date(stored.candidate.expiresAt).getTime() <= new Date(input.now).getTime()) {
      return { ok: false, code: "AUTHORIZATION_EXPIRED" };
    }

    const authorization: ExactAuthorization = {
      ...clone(stored.candidate),
      artifactId: input.artifactId
    };
    const receipt: ExactAuthorizationReceipt = {
      ...buildReceiptBinding(authorization),
      status: "authorized",
      commitClaimId: null,
      commitClaimedAt: null,
      committedAt: null,
      revokedAt: null
    };
    stored.status = "consumed";
    stored.artifactId = input.artifactId;
    this.receipts.set(input.artifactId, receipt);
    return { ok: true, authorization, receipt: clone(receipt), replayed: false };
  }

  async verifyReceipt(binding: ExactAuthorizationReceiptBinding): Promise<boolean> {
    const receipt = this.receipts.get(binding.artifactId);
    return receipt !== undefined && receiptBindingMatches(receipt, binding);
  }

  async claimCommit(
    binding: ExactAuthorizationReceiptBinding,
    claim: { readonly claimId: string; readonly claimedAt: string }
  ): Promise<ExactAuthorizationCommitResult> {
    const receipt = this.receipts.get(binding.artifactId);
    if (receipt === undefined) return { ok: false, code: "RECEIPT_NOT_FOUND" };
    if (!receiptBindingMatches(receipt, binding)) {
      return { ok: false, code: "RECEIPT_BINDING_MISMATCH" };
    }
    if (receipt.status === "revoked") return { ok: false, code: "RECEIPT_REVOKED" };
    if (receipt.status === "commit_claimed" || receipt.status === "committed") {
      if (receipt.commitClaimId !== claim.claimId) {
        return { ok: false, code: "RECEIPT_CLAIMED_BY_OTHER" };
      }
      return { ok: true, receipt: clone(receipt), replayed: true };
    }
    const claimed: ExactAuthorizationReceipt = {
      ...receipt,
      status: "commit_claimed",
      commitClaimId: claim.claimId,
      commitClaimedAt: claim.claimedAt
    };
    this.receipts.set(binding.artifactId, claimed);
    return { ok: true, receipt: clone(claimed), replayed: false };
  }

  async finalizeCommit(
    binding: ExactAuthorizationReceiptBinding,
    claimId: string,
    committedAt: string
  ): Promise<ExactAuthorizationCommitResult> {
    const receipt = this.receipts.get(binding.artifactId);
    if (receipt === undefined) return { ok: false, code: "RECEIPT_NOT_FOUND" };
    if (!receiptBindingMatches(receipt, binding)) {
      return { ok: false, code: "RECEIPT_BINDING_MISMATCH" };
    }
    if (receipt.status === "revoked") return { ok: false, code: "RECEIPT_REVOKED" };
    if (receipt.commitClaimId !== claimId || receipt.status === "authorized") {
      return { ok: false, code: "RECEIPT_CLAIMED_BY_OTHER" };
    }
    if (receipt.status === "committed") {
      return { ok: true, receipt: clone(receipt), replayed: true };
    }
    const committed: ExactAuthorizationReceipt = {
      ...receipt,
      status: "committed",
      committedAt
    };
    this.receipts.set(binding.artifactId, committed);
    return { ok: true, receipt: clone(committed), replayed: false };
  }

  async revoke(authorizationId: string, revokedAt: string): Promise<boolean> {
    const stored = this.authorizations.get(authorizationId);
    if (stored === undefined) return false;
    if (stored.status === "active") {
      stored.status = "revoked";
      stored.revokedAt = revokedAt;
      return true;
    }
    if (stored.status === "consumed" && stored.artifactId !== null) {
      const receipt = this.receipts.get(stored.artifactId);
      if (receipt?.status === "authorized") {
        this.receipts.set(stored.artifactId, {
          ...receipt,
          status: "revoked",
          revokedAt
        });
        return true;
      }
    }
    return false;
  }

  async revokeProfileReceipts(
    profileId: string,
    beforeModeEpoch: number,
    revokedAt: string
  ): Promise<number> {
    let count = 0;
    for (const [artifactId, receipt] of this.receipts) {
      if (
        receipt.profileId === profileId &&
        receipt.modeEpoch !== null &&
        receipt.modeEpoch < beforeModeEpoch &&
        receipt.status === "authorized"
      ) {
        this.receipts.set(artifactId, { ...receipt, status: "revoked", revokedAt });
        count += 1;
      }
    }
    return count;
  }
}
