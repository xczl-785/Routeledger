import { describe, expect, it } from "vitest";

import {
  buildBalancedL3AuthorizationPolicy,
  buildInteractiveSafeL3AuthorizationPolicy,
  buildPreauthorizedL3AuthorizationPolicy,
  digestL3AuthorizationPolicy,
  evaluateL3AuthorizationPolicy,
  validateL3AuthorizationPolicy,
  type L3AuthorizationEvaluationContext,
  type L3AuthorizationPolicy
} from "../index.js";

const policy = (): L3AuthorizationPolicy =>
  buildBalancedL3AuthorizationPolicy({
    policyId: "policy-1",
    projectId: "project-1",
    routeledgerRootDigest: "sha256:root-1",
    currentVersionId: "version-1",
    routeVersionIds: ["version-1", "version-2"],
    expiresAt: "2026-08-10T12:00:00.000Z",
    maxUses: 3,
    subjectId: "user-1",
    hostKind: "codex",
    clientId: "client-1"
  });

const context = (
  overrides: Partial<L3AuthorizationEvaluationContext> = {}
): L3AuthorizationEvaluationContext => ({
  projectId: "project-1",
  routeledgerRootDigest: "sha256:root-1",
  actionType: "close_version",
  targetId: "version-1",
  currentVersionId: "version-1",
  targetRelation: "current",
  gateAllowed: true,
  operationDigest: "operation-digest-1",
  now: "2026-08-10T04:00:00.000Z",
  subjectId: "user-1",
  hostKind: "codex",
  clientId: "client-1",
  ...overrides
});

describe("L3 authorization policy", () => {
  it("builds a valid deterministic balanced recommendation", () => {
    const candidate = policy();

    expect(validateL3AuthorizationPolicy(candidate)).toEqual({ valid: true, issues: [] });
    expect(candidate.defaultEffect).toBe("prompt");
    expect(candidate.alwaysPrompt).toContain("shutdown_version");
    expect(digestL3AuthorizationPolicy(candidate)).toBe(
      digestL3AuthorizationPolicy(JSON.parse(JSON.stringify(candidate)))
    );
  });

  it("builds stable interactive-safe and preauthorized templates", () => {
    const binding = {
      policyId: "template-policy",
      projectId: "project-1",
      routeledgerRootDigest: "sha256:root-1",
      subjectId: "user-1",
      hostKind: "codex",
      clientId: "client-1"
    };
    const interactive = buildInteractiveSafeL3AuthorizationPolicy(binding);
    expect(validateL3AuthorizationPolicy(interactive)).toEqual({ valid: true, issues: [] });
    expect(interactive).toMatchObject({
      mode: "interactive",
      defaultEffect: "prompt",
      rules: []
    });
    expect(interactive.alwaysPrompt).toHaveLength(10);
    expect(evaluateL3AuthorizationPolicy(interactive, context())).toMatchObject({
      effect: "prompt",
      code: "POLICY_ALWAYS_PROMPT"
    });

    const preauthorized = buildPreauthorizedL3AuthorizationPolicy(binding);
    expect(validateL3AuthorizationPolicy(preauthorized)).toEqual({ valid: true, issues: [] });
    expect(evaluateL3AuthorizationPolicy(preauthorized, context())).toMatchObject({
      effect: "prompt",
      code: "POLICY_PREAUTHORIZED_GRANT_REQUIRED"
    });
  });

  it("allows only a fully matched normal route transition", () => {
    expect(evaluateL3AuthorizationPolicy(policy(), context())).toMatchObject({
      effect: "allow",
      code: "POLICY_ALLOW",
      matchedRuleId: "allow-close-current-version"
    });

    expect(
      evaluateL3AuthorizationPolicy(
        policy(),
        context({
          actionType: "start_version",
          targetId: "version-2",
          targetRelation: "legal-successor"
        })
      )
    ).toMatchObject({
      effect: "allow",
      matchedRuleId: "allow-start-or-advance-to-successor"
    });
  });

  it("keeps interactive mode prompt-only after explicit deny precedence", () => {
    const candidate = policy();
    candidate.mode = "interactive";
    expect(evaluateL3AuthorizationPolicy(candidate, context())).toMatchObject({
      effect: "prompt",
      code: "POLICY_INTERACTIVE",
      matchedRuleId: null
    });
    candidate.rules.unshift({
      id: "deny-close-interactive",
      effect: "deny",
      actions: ["close_version"]
    });
    expect(evaluateL3AuthorizationPolicy(candidate, context())).toMatchObject({
      effect: "deny",
      code: "POLICY_DENY",
      matchedRuleId: "deny-close-interactive"
    });
  });

  it("never turns preauthorized mode rules into delegated allow", () => {
    const candidate = policy();
    candidate.mode = "preauthorized";
    expect(evaluateL3AuthorizationPolicy(candidate, context())).toMatchObject({
      effect: "prompt",
      code: "POLICY_PREAUTHORIZED_GRANT_REQUIRED",
      matchedRuleId: null
    });
  });

  it("falls back to prompt for a valid policy gap instead of stopping progress", () => {
    expect(
      evaluateL3AuthorizationPolicy(
        policy(),
        context({ actionType: "start_version", targetId: "version-2", targetRelation: "other" })
      )
    ).toMatchObject({ effect: "prompt", code: "POLICY_PROMPT" });

    expect(
      evaluateL3AuthorizationPolicy(policy(), context({ actionType: "create_version" }))
    ).toMatchObject({ effect: "prompt", code: "POLICY_ALWAYS_PROMPT" });
  });

  it("denies when the trusted binding cannot be established", () => {
    expect(
      evaluateL3AuthorizationPolicy(policy(), context({ projectId: "project-2" }))
    ).toMatchObject({ effect: "deny", code: "POLICY_BINDING_MISMATCH" });
    expect(
      evaluateL3AuthorizationPolicy(policy(), context({ routeledgerRootDigest: "sha256:other" }))
    ).toMatchObject({ effect: "deny", code: "POLICY_BINDING_MISMATCH" });
    expect(
      evaluateL3AuthorizationPolicy(policy(), context({ subjectId: "other-user" }))
    ).toMatchObject({ effect: "deny", code: "POLICY_BINDING_MISMATCH" });
  });

  it("does not allow blocked gates, stale current versions, targets outside scope, or expired rules", () => {
    expect(evaluateL3AuthorizationPolicy(policy(), context({ gateAllowed: false })).effect).toBe(
      "prompt"
    );
    expect(
      evaluateL3AuthorizationPolicy(policy(), context({ currentVersionId: "version-stale" })).effect
    ).toBe("prompt");
    expect(
      evaluateL3AuthorizationPolicy(policy(), context({ targetId: "version-outside" })).effect
    ).toBe("prompt");
    expect(
      evaluateL3AuthorizationPolicy(policy(), context({ now: "2026-08-10T12:00:00.000Z" })).effect
    ).toBe("prompt");
  });

  it("rejects malformed or unsafe policies deterministically", () => {
    const malformed = policy();
    malformed.defaultEffect = "allow" as "prompt";
    malformed.rules[0]!.conditions = undefined;

    const validation = validateL3AuthorizationPolicy(malformed);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["DEFAULT_EFFECT_INVALID", "ALLOW_GATE_REQUIRED"])
    );
    expect(evaluateL3AuthorizationPolicy(malformed, context())).toMatchObject({
      effect: "deny",
      code: "POLICY_INVALID"
    });
  });

  it("gives explicit deny rules precedence over allow rules", () => {
    const candidate = policy();
    candidate.rules.unshift({
      id: "deny-close",
      effect: "deny",
      actions: ["close_version"]
    });

    expect(evaluateL3AuthorizationPolicy(candidate, context())).toMatchObject({
      effect: "deny",
      code: "POLICY_DENY",
      matchedRuleId: "deny-close"
    });
  });
});
