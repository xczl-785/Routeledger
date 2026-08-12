import crypto from "node:crypto";

import {
  validateL3AuthorizationPolicy,
  type L3AuthorizationMode,
  type L3AuthorizationPolicy
} from "./l3-authorization.js";

export const L3_AUTHORIZATION_PROFILE_SCHEMA_VERSION = 3 as const;
export const L3_AUTHORIZATION_PROFILE_MAX_AUTHORIZATION_TTL_SECONDS = 86_400 as const;

export interface L3AuthorityBindingIdentityV2 {
  projectId: string;
  workspaceRootDigest: string;
  routeledgerRootDigest: string;
  subjectId: string;
  hostKind: string;
  trustedClientId: string | null;
}

export interface L3AuthorizationProfileLimits {
  maxAuthorizationTtlSeconds: number;
}

export interface L3AuthorizationProfileAdoptionSource {
  schemaVersion: 1;
  authorityId: string;
  policyDigest: string;
  adoptedAt: string;
}

export interface L3AuthorizationProfileV2 {
  schemaVersion: typeof L3_AUTHORIZATION_PROFILE_SCHEMA_VERSION;
  profileId: string;
  status: "active" | "disabled";
  binding: L3AuthorityBindingIdentityV2;
  mode: L3AuthorizationMode;
  modeEpoch: number;
  profileRevision: number;
  profileDigest: string;
  delegatedPolicy: L3AuthorizationPolicy | null;
  limits: L3AuthorizationProfileLimits;
  createdAt: string;
  updatedAt: string;
  adoptedFrom?: L3AuthorizationProfileAdoptionSource;
}

export interface L3AuthorizationProfileIssue {
  code: string;
  path: string;
  message: string;
}

export interface L3AuthorizationProfileValidation {
  valid: boolean;
  issues: L3AuthorizationProfileIssue[];
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isIsoDate = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
};

export const digestL3AuthorizationProfile = (
  profile: Omit<L3AuthorizationProfileV2, "profileDigest"> | L3AuthorizationProfileV2
): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          schemaVersion: profile.schemaVersion,
          profileId: profile.profileId,
          status: profile.status,
          binding: profile.binding,
          mode: profile.mode,
          modeEpoch: profile.modeEpoch,
          delegatedPolicy: profile.delegatedPolicy,
          limits: profile.limits
        })
      )
    )
    .digest("hex");

const addIssue = (
  issues: L3AuthorizationProfileIssue[],
  code: string,
  path: string,
  message: string
): void => {
  issues.push({ code, path, message });
};

export const validateL3AuthorizationProfile = (
  profile: L3AuthorizationProfileV2
): L3AuthorizationProfileValidation => {
  const issues: L3AuthorizationProfileIssue[] = [];
  if (profile.schemaVersion !== L3_AUTHORIZATION_PROFILE_SCHEMA_VERSION) {
    addIssue(issues, "SCHEMA_VERSION_INVALID", "$.schemaVersion", "unsupported profile schema");
  }
  if (!isNonEmptyString(profile.profileId)) {
    addIssue(issues, "PROFILE_ID_REQUIRED", "$.profileId", "profileId is required");
  }
  if (profile.status !== "active" && profile.status !== "disabled") {
    addIssue(issues, "PROFILE_STATUS_INVALID", "$.status", "unknown profile status");
  }
  const bindingFields: Array<keyof Omit<L3AuthorityBindingIdentityV2, "trustedClientId">> = [
    "projectId",
    "workspaceRootDigest",
    "routeledgerRootDigest",
    "subjectId",
    "hostKind"
  ];
  for (const field of bindingFields) {
    if (!isNonEmptyString(profile.binding?.[field])) {
      addIssue(
        issues,
        "PROFILE_BINDING_REQUIRED",
        `$.binding.${field}`,
        `${field} is required`
      );
    }
  }
  if (
    profile.binding?.trustedClientId !== null &&
    !isNonEmptyString(profile.binding?.trustedClientId)
  ) {
    addIssue(
      issues,
      "TRUSTED_CLIENT_ID_INVALID",
      "$.binding.trustedClientId",
      "trustedClientId must be null or a non-empty string"
    );
  }
  if (!(["interactive", "delegated", "preauthorized"] as unknown[]).includes(profile.mode)) {
    addIssue(issues, "PROFILE_MODE_INVALID", "$.mode", "unknown authorization mode");
  }
  if (!Number.isInteger(profile.modeEpoch) || profile.modeEpoch <= 0) {
    addIssue(issues, "MODE_EPOCH_INVALID", "$.modeEpoch", "modeEpoch must be positive");
  }
  if (!Number.isInteger(profile.profileRevision) || profile.profileRevision <= 0) {
    addIssue(
      issues,
      "PROFILE_REVISION_INVALID",
      "$.profileRevision",
      "profileRevision must be positive"
    );
  }
  if (
    !Number.isInteger(profile.limits?.maxAuthorizationTtlSeconds) ||
    profile.limits.maxAuthorizationTtlSeconds < 30 ||
    profile.limits.maxAuthorizationTtlSeconds > L3_AUTHORIZATION_PROFILE_MAX_AUTHORIZATION_TTL_SECONDS
  ) {
    addIssue(
      issues,
      "MAX_GRANT_TTL_INVALID",
      "$.limits.maxAuthorizationTtlSeconds",
      "maxAuthorizationTtlSeconds must be from 30 through 86400"
    );
  }
  if (profile.mode === "delegated" || profile.mode === "preauthorized") {
    if (profile.delegatedPolicy === null) {
      if (profile.mode === "delegated") {
        addIssue(
          issues,
          "DELEGATED_POLICY_REQUIRED",
          "$.delegatedPolicy",
          "delegated mode requires a policy"
        );
      }
    } else {
      const policyValidation = validateL3AuthorizationPolicy(profile.delegatedPolicy);
      if (!policyValidation.valid) {
        addIssue(
          issues,
          "DELEGATED_POLICY_INVALID",
          "$.delegatedPolicy",
          policyValidation.issues[0]?.code ?? "unknown policy issue"
        );
      }
      if (profile.delegatedPolicy.mode !== "delegated") {
        addIssue(
          issues,
          "DELEGATED_POLICY_MODE_INVALID",
          "$.delegatedPolicy.mode",
          "the standing policy must use delegated evaluation semantics"
        );
      }
      const policyBinding = profile.delegatedPolicy.binding;
      if (
        policyBinding.projectId !== profile.binding.projectId ||
        policyBinding.routeledgerRootDigest !== profile.binding.routeledgerRootDigest ||
        policyBinding.subjectId !== profile.binding.subjectId ||
        policyBinding.hostKind !== profile.binding.hostKind ||
        (policyBinding.clientId ?? null) !== profile.binding.trustedClientId
      ) {
        addIssue(
          issues,
          "DELEGATED_POLICY_BINDING_MISMATCH",
          "$.delegatedPolicy.binding",
          "the delegated policy must exactly match the profile binding"
        );
      }
    }
  } else if (profile.delegatedPolicy !== null) {
    addIssue(
      issues,
      "DELEGATED_POLICY_FORBIDDEN",
      "$.delegatedPolicy",
      "only delegated or preauthorized mode may carry a standing policy"
    );
  }
  if (!isIsoDate(profile.createdAt)) {
    addIssue(issues, "CREATED_AT_INVALID", "$.createdAt", "createdAt must be an ISO timestamp");
  }
  if (!isIsoDate(profile.updatedAt)) {
    addIssue(issues, "UPDATED_AT_INVALID", "$.updatedAt", "updatedAt must be an ISO timestamp");
  }
  if (isIsoDate(profile.createdAt) && isIsoDate(profile.updatedAt)) {
    if (Date.parse(profile.updatedAt) < Date.parse(profile.createdAt)) {
      addIssue(
        issues,
        "PROFILE_TIME_ORDER_INVALID",
        "$.updatedAt",
        "updatedAt must not precede createdAt"
      );
    }
  }
  if (profile.adoptedFrom !== undefined) {
    if (
      profile.adoptedFrom.schemaVersion !== 1 ||
      !isNonEmptyString(profile.adoptedFrom.authorityId) ||
      !isNonEmptyString(profile.adoptedFrom.policyDigest) ||
      !isIsoDate(profile.adoptedFrom.adoptedAt)
    ) {
      addIssue(
        issues,
        "ADOPTION_SOURCE_INVALID",
        "$.adoptedFrom",
        "adoptedFrom must contain exact v1 provenance"
      );
    }
  }
  if (isNonEmptyString(profile.profileDigest)) {
    if (profile.profileDigest !== digestL3AuthorizationProfile(profile)) {
      addIssue(
        issues,
        "PROFILE_DIGEST_MISMATCH",
        "$.profileDigest",
        "profileDigest does not match the authorization-effective profile"
      );
    }
  } else {
    addIssue(issues, "PROFILE_DIGEST_REQUIRED", "$.profileDigest", "profileDigest is required");
  }
  return { valid: issues.length === 0, issues };
};
