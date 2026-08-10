import fs from "node:fs";
import path from "node:path";

import {
  validateL3AuthorizationPolicy,
  type L3AuthorizationPolicy,
  type L3AuthorizationPolicyIssue
} from "@routeledger/core";

import { ROUTELEDGER_DIRECTORY } from "./storage-paths.js";

export const L3_AUTHORIZATION_POLICY_FILENAME = "l3-authorization.json";

export type L3AuthorizationPolicyFileResolution =
  | { status: "missing"; path: string }
  | { status: "ready"; path: string; policy: L3AuthorizationPolicy }
  | { status: "invalid"; path: string; issues: L3AuthorizationPolicyIssue[] };

export const getL3AuthorizationPolicyPath = (routeledgerRoot: string): string =>
  path.join(routeledgerRoot, ROUTELEDGER_DIRECTORY, L3_AUTHORIZATION_POLICY_FILENAME);

export const resolveL3AuthorizationPolicyFile = (
  routeledgerRoot: string
): L3AuthorizationPolicyFileResolution => {
  const policyPath = getL3AuthorizationPolicyPath(routeledgerRoot);
  if (!fs.existsSync(policyPath)) return { status: "missing", path: policyPath };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    return {
      status: "invalid",
      path: policyPath,
      issues: [{
        code: "POLICY_FILE_MALFORMED_JSON",
        path: "$",
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "invalid",
      path: policyPath,
      issues: [{ code: "POLICY_FILE_INVALID_ROOT", path: "$", message: "policy must be an object" }]
    };
  }

  const policy = parsed as L3AuthorizationPolicy;
  const validation = validateL3AuthorizationPolicy(policy);
  return validation.valid
    ? { status: "ready", path: policyPath, policy }
    : { status: "invalid", path: policyPath, issues: validation.issues };
};
