import fs from "node:fs";
import path from "node:path";
import { validateL3AuthorizationPolicy } from "../../core/src/index.js";
import { ROUTELEDGER_DIRECTORY } from "./storage-paths.js";
export const L3_AUTHORIZATION_POLICY_FILENAME = "l3-authorization.json";
export const getL3AuthorizationPolicyPath = (routeledgerRoot) => path.join(routeledgerRoot, ROUTELEDGER_DIRECTORY, L3_AUTHORIZATION_POLICY_FILENAME);
export const resolveL3AuthorizationPolicyFile = (routeledgerRoot) => {
    const policyPath = getL3AuthorizationPolicyPath(routeledgerRoot);
    if (!fs.existsSync(policyPath))
        return { status: "missing", path: policyPath };
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    }
    catch (error) {
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
    const policy = parsed;
    const validation = validateL3AuthorizationPolicy(policy);
    return validation.valid
        ? { status: "ready", path: policyPath, policy }
        : { status: "invalid", path: policyPath, issues: validation.issues };
};
