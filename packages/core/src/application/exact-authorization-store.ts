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
  acquireCommitOwnership(authorizationId: string, ownerId: string): Promise<boolean>;
  releaseCommitOwnership(authorizationId: string, ownerId: string): Promise<void>;
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

export type StoredExactAuthorization = {
  candidate: ExactAuthorizationCandidate;
  status: ExactAuthorizationStatus;
  artifactId: string | null;
  revokedAt: string | null;
};

export interface ExactAuthorizationStoreState {
  authorizations: Record<string, StoredExactAuthorization>;
  receipts: Record<string, ExactAuthorizationReceipt>;
  commitOwners: Record<string, string>;
}

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
  receipt.authorizationId === binding.authorizationId &&
  receipt.artifactId === binding.artifactId &&
  bindingMatches(receipt.binding, binding.binding) &&
  receipt.issuer === binding.issuer &&
  receipt.audience === binding.audience &&
  receipt.subjectId === binding.subjectId &&
  receipt.source === binding.source &&
  receipt.decisionRef === binding.decisionRef &&
  receipt.policyId === binding.policyId &&
  receipt.policyDigest === binding.policyDigest &&
  receipt.profileId === binding.profileId &&
  receipt.modeEpoch === binding.modeEpoch &&
  receipt.profileDigest === binding.profileDigest &&
  receipt.hostKind === binding.hostKind &&
  receipt.clientId === binding.clientId &&
  receipt.createdAt === binding.createdAt &&
  receipt.expiresAt === binding.expiresAt;

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
  private readonly authorizations = new Map<string, StoredExactAuthorization>();
  private readonly receipts = new Map<string, ExactAuthorizationReceipt>();
  private readonly commitOwners = new Map<string, string>();

  constructor(state?: ExactAuthorizationStoreState) {
    if (state === undefined) return;
    for (const [id, stored] of Object.entries(state.authorizations)) {
      validateCandidate(stored.candidate);
      if (id !== stored.candidate.authorizationId) {
        throw new Error("Exact authorization state key mismatch.");
      }
      this.authorizations.set(id, clone(stored));
    }
    for (const [artifactId, receipt] of Object.entries(state.receipts)) {
      if (artifactId !== receipt.artifactId) throw new Error("Exact receipt state key mismatch.");
      this.receipts.set(artifactId, clone(receipt));
    }
    for (const [authorizationId, ownerId] of Object.entries(state.commitOwners)) {
      requireNonEmpty(authorizationId, "authorizationId");
      requireNonEmpty(ownerId, "commit ownerId");
      this.commitOwners.set(authorizationId, ownerId);
    }
  }

  exportState(): ExactAuthorizationStoreState {
    return {
      authorizations: Object.fromEntries(
        [...this.authorizations.entries()].map(([id, value]) => [id, clone(value)])
      ),
      receipts: Object.fromEntries(
        [...this.receipts.entries()].map(([id, value]) => [id, clone(value)])
      ),
      commitOwners: Object.fromEntries(this.commitOwners.entries())
    };
  }

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

  async acquireCommitOwnership(authorizationId: string, ownerId: string): Promise<boolean> {
    requireNonEmpty(authorizationId, "authorizationId");
    requireNonEmpty(ownerId, "commit ownerId");
    const current = this.commitOwners.get(authorizationId);
    if (current === undefined) {
      this.commitOwners.set(authorizationId, ownerId);
      return true;
    }
    return current === ownerId;
  }

  async releaseCommitOwnership(authorizationId: string, ownerId: string): Promise<void> {
    if (this.commitOwners.get(authorizationId) === ownerId) {
      this.commitOwners.delete(authorizationId);
    }
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
