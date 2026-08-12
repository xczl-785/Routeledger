import type { L3ActionType } from "@routeledger/core";

/** @internal Persisted v1 audit shape; decoder/migrator only. */
export interface LegacyL3AuthorizationGrant {
  id: string;
  issuer: string;
  subjectId: string;
  audience: string;
  projectId: string;
  routeledgerRootDigest: string;
  profileId?: string;
  modeEpoch?: number;
  profileDigest?: string;
  allowedActions: L3ActionType[];
  allowedTargetIds: string[];
  operationDigest: string | null;
  scope: "operation" | "turn" | "session" | "time_window";
  source: "user_interaction" | "delegated_policy" | "preauthorized" | "host_admission";
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
  status: "active" | "revoked" | "exhausted";
  revokedAt: string | null;
}

/** @internal Persisted v1 audit shape; never accepted as commit authority. */
export interface LegacyL3AuthorizationReceipt {
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
  decisionRef: string;
  createdAt: string;
  expiresAt: string;
  consumedUse: number;
  status?: "authorized" | "commit_claimed" | "committed" | "revoked";
  [key: string]: unknown;
}

/** @internal Field names accepted only while decoding pre-exact host authority files. */
export const LEGACY_AUTHORITY_CONFIG_TTL_FIELD = "grantTtlSeconds" as const;

/** @internal Field names accepted only while tombstoning pre-exact records. */
export const LEGACY_GRANT_FIELDS = {
  actions: "allowedActions",
  targets: "allowedTargetIds",
  limit: "maxUses",
  count: "uses"
} as const;
