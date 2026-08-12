import { describe, expect, it } from "vitest";

import {
  buildBalancedL3AuthorizationPolicy,
  digestL3AuthorizationProfile,
  validateL3AuthorizationProfile,
  type L3AuthorizationProfileV2
} from "../index.js";

const profile = (
  overrides: Partial<L3AuthorizationProfileV2> = {}
): L3AuthorizationProfileV2 => {
  const binding = {
    projectId: "project-1",
    workspaceRootDigest: "sha256:workspace-1",
    routeledgerRootDigest: "sha256:root-1",
    subjectId: "user-1",
    hostKind: "codex",
    trustedClientId: "client-1"
  };
  const policy = buildBalancedL3AuthorizationPolicy({
    policyId: "balanced-1",
    projectId: binding.projectId,
    routeledgerRootDigest: binding.routeledgerRootDigest,
    currentVersionId: "version-1",
    routeVersionIds: ["version-1", "version-2"],
    expiresAt: "2026-08-12T04:00:00.000Z",
    decisionBudget: 16,
    subjectId: binding.subjectId,
    hostKind: binding.hostKind,
    clientId: binding.trustedClientId
  });
  const base = {
    schemaVersion: 3 as const,
    profileId: "profile-1",
    status: "active" as const,
    binding,
    mode: "delegated" as const,
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy: policy,
    limits: { maxAuthorizationTtlSeconds: 86_400 },
    createdAt: "2026-08-11T04:00:00.000Z",
    updatedAt: "2026-08-11T04:00:00.000Z"
  };
  const candidate = { ...base, ...overrides };
  const { profileDigest: suppliedDigest, ...digestInput } = candidate as typeof candidate & {
    profileDigest?: string;
  };
  return {
    ...candidate,
    profileDigest: suppliedDigest ?? digestL3AuthorizationProfile(digestInput)
  };
};

describe("L3 authorization profile v2", () => {
  it("builds a stable digest from only authorization-effective fields", () => {
    const original = profile();
    const metadataOnly = profile({
      profileRevision: 2,
      updatedAt: "2026-08-11T05:00:00.000Z"
    });
    expect(metadataOnly.profileDigest).toBe(original.profileDigest);
    expect(validateL3AuthorizationProfile(original)).toEqual({ valid: true, issues: [] });
    expect(validateL3AuthorizationProfile(metadataOnly)).toEqual({ valid: true, issues: [] });
  });

  it("changes the digest when binding, mode epoch, policy, limits, or status changes", () => {
    const original = profile();
    const variants = [
      profile({
        binding: { ...original.binding, workspaceRootDigest: "sha256:workspace-2" }
      }),
      profile({ modeEpoch: 2 }),
      profile({
        delegatedPolicy: {
          ...original.delegatedPolicy!,
          alwaysPrompt: [...original.delegatedPolicy!.alwaysPrompt, "close_version"]
        }
      }),
      profile({ limits: { maxAuthorizationTtlSeconds: 3600 } }),
      profile({ status: "disabled" })
    ];
    for (const variant of variants) expect(variant.profileDigest).not.toBe(original.profileDigest);
  });

  it("requires exact delegated policy bindings and forbids policy authority in other modes", () => {
    const original = profile();
    const mismatched = profile({
      delegatedPolicy: {
        ...original.delegatedPolicy!,
        binding: { ...original.delegatedPolicy!.binding, projectId: "other-project" }
      }
    });
    expect(validateL3AuthorizationProfile(mismatched).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "DELEGATED_POLICY_BINDING_MISMATCH" })
      ])
    );

    const interactive = profile({ mode: "interactive", delegatedPolicy: null });
    expect(validateL3AuthorizationProfile(interactive)).toEqual({ valid: true, issues: [] });
    const interactiveWithPolicy = profile({ mode: "interactive" });
    expect(validateL3AuthorizationProfile(interactiveWithPolicy).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DELEGATED_POLICY_FORBIDDEN" })])
    );
  });

  it("rejects a stale or forged stored profile digest", () => {
    const candidate = profile();
    expect(
      validateL3AuthorizationProfile({ ...candidate, profileDigest: "forged" }).issues
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PROFILE_DIGEST_MISMATCH" })]));
  });
});
