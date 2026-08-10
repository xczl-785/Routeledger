import crypto from "node:crypto";

import type { L3ActionType } from "./types.js";

export const L3_AUTHORIZATION_POLICY_SCHEMA_VERSION = 1 as const;

export const L3_AUTHORIZATION_ACTIONS = [
  "start_version",
  "close_version",
  "shutdown_version",
  "reopen_version",
  "set_current_version",
  "advance_to_version",
  "create_version",
  "insert_version",
  "create_child_version",
  "reorder_versions"
] as const satisfies readonly L3ActionType[];

export const BALANCED_AUTO_ACTIONS = [
  "start_version",
  "close_version",
  "advance_to_version"
] as const satisfies readonly L3ActionType[];

export const BALANCED_ALWAYS_PROMPT_ACTIONS = [
  "shutdown_version",
  "reopen_version",
  "set_current_version",
  "create_version",
  "insert_version",
  "create_child_version",
  "reorder_versions"
] as const satisfies readonly L3ActionType[];

export type L3AuthorizationMode = "interactive" | "delegated" | "preauthorized";
export type L3AuthorizationEffect = "allow" | "prompt" | "deny";
export type L3AuthorizationScope = "operation" | "turn" | "session" | "time_window";
export type L3AuthorizationTargetRelation = "current" | "legal-successor" | "other";

export interface L3AuthorizationPolicyBinding {
  projectId: string;
  routeledgerRootDigest: string;
  subjectId?: string;
  hostKind?: string;
  clientId?: string;
}

export interface L3AuthorizationRuleResources {
  targetIds?: string[];
}

export interface L3AuthorizationRuleConditions {
  gateMustPass: true;
  allowedTargetRelations?: L3AuthorizationTargetRelation[];
  requiredCurrentVersionId?: string;
  expiresAt?: string;
  maxUses?: number;
}

export interface L3AuthorizationRule {
  id: string;
  effect: "allow" | "deny";
  actions: L3ActionType[];
  resources?: L3AuthorizationRuleResources;
  conditions?: L3AuthorizationRuleConditions;
}

export interface L3AuthorizationPolicy {
  schemaVersion: typeof L3_AUTHORIZATION_POLICY_SCHEMA_VERSION;
  policyId: string;
  mode: L3AuthorizationMode;
  binding: L3AuthorizationPolicyBinding;
  defaultEffect: "prompt" | "deny";
  rules: L3AuthorizationRule[];
  alwaysPrompt: L3ActionType[];
}

export interface L3AuthorizationEvaluationContext {
  projectId: string;
  routeledgerRootDigest: string;
  actionType: L3ActionType;
  targetId: string;
  currentVersionId: string | null;
  targetRelation: L3AuthorizationTargetRelation;
  gateAllowed: boolean;
  operationDigest: string;
  now: string;
  subjectId?: string;
  hostKind?: string;
  clientId?: string;
}

export interface L3AuthorizationPolicyIssue {
  code: string;
  path: string;
  message: string;
}

export interface L3AuthorizationPolicyValidation {
  valid: boolean;
  issues: L3AuthorizationPolicyIssue[];
}

export interface L3AuthorizationPolicyDecision {
  effect: L3AuthorizationEffect;
  code:
    | "POLICY_ALLOW"
    | "POLICY_PROMPT"
    | "POLICY_DENY"
    | "POLICY_ALWAYS_PROMPT"
    | "POLICY_BINDING_MISMATCH"
    | "POLICY_INVALID";
  policyId: string;
  policyDigest: string;
  matchedRuleId: string | null;
  issues: L3AuthorizationPolicyIssue[];
}

export interface BuildBalancedL3AuthorizationPolicyInput {
  policyId: string;
  projectId: string;
  routeledgerRootDigest: string;
  currentVersionId: string | null;
  routeVersionIds: string[];
  expiresAt: string;
  maxUses: number;
  subjectId?: string;
  hostKind?: string;
  clientId?: string;
}

const actionSet = new Set<string>(L3_AUTHORIZATION_ACTIONS);
const modeSet = new Set<string>(["interactive", "delegated", "preauthorized"]);
const relationSet = new Set<string>(["current", "legal-successor", "other"]);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isIsoDate = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
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

export const digestL3AuthorizationPolicy = (policy: L3AuthorizationPolicy): string =>
  crypto.createHash("sha256").update(JSON.stringify(canonicalize(policy))).digest("hex");

const addIssue = (
  issues: L3AuthorizationPolicyIssue[],
  code: string,
  path: string,
  message: string
) => issues.push({ code, path, message });

const validateActions = (
  value: unknown,
  path: string,
  issues: L3AuthorizationPolicyIssue[]
) => {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(issues, "ACTIONS_REQUIRED", path, "actions must be a non-empty array");
    return;
  }
  for (const [index, action] of value.entries()) {
    if (!isNonEmptyString(action) || !actionSet.has(action)) {
      addIssue(issues, "ACTION_INVALID", `${path}[${index}]`, "unknown L3 action");
    }
  }
};

export const validateL3AuthorizationPolicy = (
  policy: L3AuthorizationPolicy
): L3AuthorizationPolicyValidation => {
  const issues: L3AuthorizationPolicyIssue[] = [];

  if (policy.schemaVersion !== L3_AUTHORIZATION_POLICY_SCHEMA_VERSION) {
    addIssue(issues, "SCHEMA_VERSION_INVALID", "$.schemaVersion", "unsupported schema version");
  }
  if (!isNonEmptyString(policy.policyId)) {
    addIssue(issues, "POLICY_ID_REQUIRED", "$.policyId", "policyId is required");
  }
  if (!modeSet.has(policy.mode)) {
    addIssue(issues, "MODE_INVALID", "$.mode", "unknown authorization mode");
  }
  if (!isNonEmptyString(policy.binding?.projectId)) {
    addIssue(issues, "PROJECT_BINDING_REQUIRED", "$.binding.projectId", "project binding is required");
  }
  if (!isNonEmptyString(policy.binding?.routeledgerRootDigest)) {
    addIssue(
      issues,
      "ROOT_BINDING_REQUIRED",
      "$.binding.routeledgerRootDigest",
      "RouteLedger root digest binding is required"
    );
  }
  if (policy.defaultEffect !== "prompt" && policy.defaultEffect !== "deny") {
    addIssue(
      issues,
      "DEFAULT_EFFECT_INVALID",
      "$.defaultEffect",
      "defaultEffect must be prompt or deny"
    );
  }
  if (!Array.isArray(policy.rules)) {
    addIssue(issues, "RULES_REQUIRED", "$.rules", "rules must be an array");
  } else {
    const ruleIds = new Set<string>();
    for (const [index, rule] of policy.rules.entries()) {
      const base = `$.rules[${index}]`;
      if (!isNonEmptyString(rule.id)) {
        addIssue(issues, "RULE_ID_REQUIRED", `${base}.id`, "rule id is required");
      } else if (ruleIds.has(rule.id)) {
        addIssue(issues, "RULE_ID_DUPLICATE", `${base}.id`, "rule id must be unique");
      } else {
        ruleIds.add(rule.id);
      }
      if (rule.effect !== "allow" && rule.effect !== "deny") {
        addIssue(issues, "RULE_EFFECT_INVALID", `${base}.effect`, "rule effect must be allow or deny");
      }
      validateActions(rule.actions, `${base}.actions`, issues);
      if (rule.resources?.targetIds !== undefined) {
        if (
          !Array.isArray(rule.resources.targetIds) ||
          rule.resources.targetIds.length === 0 ||
          rule.resources.targetIds.some((targetId) => !isNonEmptyString(targetId))
        ) {
          addIssue(
            issues,
            "TARGET_IDS_INVALID",
            `${base}.resources.targetIds`,
            "targetIds must be a non-empty string array when provided"
          );
        }
      }
      if (rule.effect === "allow" && rule.conditions?.gateMustPass !== true) {
        addIssue(
          issues,
          "ALLOW_GATE_REQUIRED",
          `${base}.conditions.gateMustPass`,
          "allow rules must require a passing live gate"
        );
      }
      if (rule.effect === "allow" && !isIsoDate(rule.conditions?.expiresAt)) {
        addIssue(
          issues,
          "ALLOW_EXPIRY_REQUIRED",
          `${base}.conditions.expiresAt`,
          "allow rules must have an ISO expiry"
        );
      }
      if (
        rule.effect === "allow" &&
        (!Number.isInteger(rule.conditions?.maxUses) || (rule.conditions?.maxUses ?? 0) <= 0)
      ) {
        addIssue(
          issues,
          "ALLOW_MAX_USES_REQUIRED",
          `${base}.conditions.maxUses`,
          "allow rules must have a positive maximum-use budget"
        );
      }
      if (rule.conditions?.allowedTargetRelations !== undefined) {
        if (
          !Array.isArray(rule.conditions.allowedTargetRelations) ||
          rule.conditions.allowedTargetRelations.length === 0 ||
          rule.conditions.allowedTargetRelations.some((relation) => !relationSet.has(relation))
        ) {
          addIssue(
            issues,
            "TARGET_RELATIONS_INVALID",
            `${base}.conditions.allowedTargetRelations`,
            "allowedTargetRelations contains an invalid value"
          );
        }
      }
      if (
        rule.conditions?.expiresAt !== undefined &&
        !isIsoDate(rule.conditions.expiresAt)
      ) {
        addIssue(
          issues,
          "EXPIRY_INVALID",
          `${base}.conditions.expiresAt`,
          "expiresAt must be an ISO timestamp"
        );
      }
      if (
        rule.conditions?.maxUses !== undefined &&
        (!Number.isInteger(rule.conditions.maxUses) || rule.conditions.maxUses <= 0)
      ) {
        addIssue(
          issues,
          "MAX_USES_INVALID",
          `${base}.conditions.maxUses`,
          "maxUses must be a positive integer"
        );
      }
    }
  }
  if (!Array.isArray(policy.alwaysPrompt)) {
    addIssue(issues, "ALWAYS_PROMPT_REQUIRED", "$.alwaysPrompt", "alwaysPrompt must be an array");
  } else {
    for (const [index, action] of policy.alwaysPrompt.entries()) {
      if (!actionSet.has(action)) {
        addIssue(
          issues,
          "ALWAYS_PROMPT_ACTION_INVALID",
          `$.alwaysPrompt[${index}]`,
          "unknown L3 action"
        );
      }
    }
  }

  return { valid: issues.length === 0, issues };
};

const bindingMatches = (
  binding: L3AuthorizationPolicyBinding,
  context: L3AuthorizationEvaluationContext
): boolean =>
  binding.projectId === context.projectId &&
  binding.routeledgerRootDigest === context.routeledgerRootDigest &&
  (binding.subjectId === undefined || binding.subjectId === context.subjectId) &&
  (binding.hostKind === undefined || binding.hostKind === context.hostKind) &&
  (binding.clientId === undefined || binding.clientId === context.clientId);

const ruleMatches = (
  rule: L3AuthorizationRule,
  context: L3AuthorizationEvaluationContext
): boolean => {
  if (!rule.actions.includes(context.actionType)) return false;
  if (rule.resources?.targetIds !== undefined && !rule.resources.targetIds.includes(context.targetId)) {
    return false;
  }
  if (rule.conditions?.gateMustPass === true && !context.gateAllowed) return false;
  if (
    rule.conditions?.allowedTargetRelations !== undefined &&
    !rule.conditions.allowedTargetRelations.includes(context.targetRelation)
  ) {
    return false;
  }
  if (
    rule.conditions?.requiredCurrentVersionId !== undefined &&
    rule.conditions.requiredCurrentVersionId !== context.currentVersionId
  ) {
    return false;
  }
  if (
    rule.conditions?.expiresAt !== undefined &&
    Date.parse(context.now) >= Date.parse(rule.conditions.expiresAt)
  ) {
    return false;
  }
  return true;
};

export const evaluateL3AuthorizationPolicy = (
  policy: L3AuthorizationPolicy,
  context: L3AuthorizationEvaluationContext
): L3AuthorizationPolicyDecision => {
  const validation = validateL3AuthorizationPolicy(policy);
  const policyDigest = digestL3AuthorizationPolicy(policy);
  const base = { policyId: policy.policyId, policyDigest };

  if (!validation.valid) {
    return {
      ...base,
      effect: "deny",
      code: "POLICY_INVALID",
      matchedRuleId: null,
      issues: validation.issues
    };
  }
  if (!bindingMatches(policy.binding, context)) {
    return {
      ...base,
      effect: "deny",
      code: "POLICY_BINDING_MISMATCH",
      matchedRuleId: null,
      issues: []
    };
  }

  const denyRule = policy.rules.find(
    (rule) => rule.effect === "deny" && ruleMatches(rule, context)
  );
  if (denyRule !== undefined) {
    return {
      ...base,
      effect: "deny",
      code: "POLICY_DENY",
      matchedRuleId: denyRule.id,
      issues: []
    };
  }
  if (policy.alwaysPrompt.includes(context.actionType)) {
    return {
      ...base,
      effect: "prompt",
      code: "POLICY_ALWAYS_PROMPT",
      matchedRuleId: null,
      issues: []
    };
  }

  const allowRule = policy.rules.find(
    (rule) => rule.effect === "allow" && ruleMatches(rule, context)
  );
  if (allowRule !== undefined) {
    return {
      ...base,
      effect: "allow",
      code: "POLICY_ALLOW",
      matchedRuleId: allowRule.id,
      issues: []
    };
  }

  return {
    ...base,
    effect: policy.defaultEffect,
    code: policy.defaultEffect === "prompt" ? "POLICY_PROMPT" : "POLICY_DENY",
    matchedRuleId: null,
    issues: []
  };
};

export const buildBalancedL3AuthorizationPolicy = (
  input: BuildBalancedL3AuthorizationPolicyInput
): L3AuthorizationPolicy => ({
  schemaVersion: L3_AUTHORIZATION_POLICY_SCHEMA_VERSION,
  policyId: input.policyId,
  mode: "delegated",
  binding: {
    projectId: input.projectId,
    routeledgerRootDigest: input.routeledgerRootDigest,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
    ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
    ...(input.clientId === undefined ? {} : { clientId: input.clientId })
  },
  defaultEffect: "prompt",
  rules: [
    {
      id: "allow-close-current-version",
      effect: "allow",
      actions: ["close_version"],
      resources: { targetIds: [...input.routeVersionIds] },
      conditions: {
        gateMustPass: true,
        allowedTargetRelations: ["current"],
        ...(input.currentVersionId === null
          ? {}
          : { requiredCurrentVersionId: input.currentVersionId }),
        expiresAt: input.expiresAt,
        maxUses: input.maxUses
      }
    },
    {
      id: "allow-start-or-advance-to-successor",
      effect: "allow",
      actions: ["start_version", "advance_to_version"],
      resources: { targetIds: [...input.routeVersionIds] },
      conditions: {
        gateMustPass: true,
        allowedTargetRelations: ["legal-successor"],
        ...(input.currentVersionId === null
          ? {}
          : { requiredCurrentVersionId: input.currentVersionId }),
        expiresAt: input.expiresAt,
        maxUses: input.maxUses
      }
    }
  ],
  alwaysPrompt: [...BALANCED_ALWAYS_PROMPT_ACTIONS]
});
