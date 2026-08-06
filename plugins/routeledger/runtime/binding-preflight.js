import path from "node:path";
import { arePhysicalPathsEqualSync } from "./physical-path.js";
const summarizeReceivedValue = (value) => {
    if (typeof value === "string") {
        return value.length > 200 ? `${value.slice(0, 200)}...` : value;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (value === undefined) {
        return null;
    }
    return Object.prototype.toString.call(value);
};
export const getBindingRecommendedNextActions = (binding) => {
    const actions = [
        {
            type: "inspect_runtime",
            tool: "get_runtime_context",
            description: "Read the current binding summary before retrying route operations."
        }
    ];
    if (binding.status === "uninitialized") {
        actions.push({
            type: "inspect_workspace",
            tool: "discover_routeledger_roots",
            description: "Inspect workspaceRoot for other RouteLedger candidates before initializing a new state root."
        });
        actions.push({
            type: "plan_binding",
            tool: "plan_routeledger_binding",
            description: "Plan the binding target before rendering host config or initializing RouteLedger."
        });
        actions.push({
            type: "initialize_routeledger",
            tool: "init_project",
            description: "Initialize .routeledger at the bound routeledgerRoot after confirming no better candidate exists.",
            requiresUserDecision: true
        });
    }
    else if (binding.status === "unbound" || binding.status === "invalid") {
        if (binding.workspaceRootConfidence === "low" ||
            binding.workspaceRootConfidence === "none") {
            actions.push({
                type: "activate_explicit_workspace_binding",
                tool: "activate_routeledger_binding",
                fields: ["workspaceRoot", "routeledgerRoot"],
                description: "Pass the host project absolute workspaceRoot (and optional in-workspace routeledgerRoot). Do not use the MCP process cwd."
            });
            return actions;
        }
        actions.push({
            type: "inspect_workspace",
            tool: "discover_routeledger_roots",
            description: "Inspect workspaceRoot for RouteLedger candidates."
        });
        actions.push({
            type: "plan_binding",
            tool: "plan_routeledger_binding",
            description: "Plan a valid workspaceRoot + routeledgerRoot binding before touching host config."
        });
        actions.push({
            type: "render_codex_config",
            tool: "render_host_binding_config",
            description: "Render a Codex binding config or fragment once the target RouteLedger root is chosen."
        });
    }
    return actions;
};
export const isBindingToolKindAllowed = (binding, toolKind) => {
    switch (toolKind) {
        case "diagnostic":
        case "discovery":
        case "planning":
            return true;
        case "bootstrap":
            return binding.status === "bound" || binding.status === "uninitialized";
        case "read":
        case "write":
            return binding.status === "bound";
        default: {
            const exhaustiveToolKind = toolKind;
            return exhaustiveToolKind;
        }
    }
};
const createBlockedFailure = (toolName, toolKind, binding, blockedReason) => ({
    code: blockedReason.code,
    message: blockedReason.message,
    details: {
        toolName,
        toolKind,
        binding,
        blockedReason,
        recommendedNextActions: getBindingRecommendedNextActions(binding)
    }
});
export const runBindingPreflight = (options) => {
    if (options.toolKind === "diagnostic" ||
        options.toolKind === "discovery" ||
        options.toolKind === "planning") {
        return { allowed: true };
    }
    const requiresWriteAssertion = options.toolKind === "write" || options.toolKind === "bootstrap";
    if (options.toolKind === "bootstrap") {
        if (options.binding.status !== "bound" && options.binding.status !== "uninitialized") {
            return {
                allowed: false,
                failure: createBlockedFailure(options.toolName, options.toolKind, options.binding, options.binding.status === "invalid"
                    ? {
                        code: "ROUTELEDGER_BINDING_INVALID",
                        message: `${options.toolName} requires a valid workspaceRoot/routeledgerRoot binding.`
                    }
                    : {
                        code: "ROUTELEDGER_BINDING_REQUIRED",
                        message: `${options.toolName} requires routeledgerRoot to be bound before initialization can proceed.`
                    })
            };
        }
    }
    if (options.toolKind !== "bootstrap" && options.binding.status !== "bound") {
        const blockedReason = options.binding.status === "uninitialized"
            ? {
                code: "ROUTELEDGER_NOT_INITIALIZED",
                message: `${options.toolName} requires an initialized .routeledger at the bound routeledgerRoot.`
            }
            : options.binding.status === "invalid"
                ? {
                    code: "ROUTELEDGER_BINDING_INVALID",
                    message: `${options.toolName} requires a valid workspaceRoot/routeledgerRoot binding.`
                }
                : {
                    code: "ROUTELEDGER_BINDING_REQUIRED",
                    message: `${options.toolName} requires a bound routeledgerRoot.`
                };
        return {
            allowed: false,
            failure: createBlockedFailure(options.toolName, options.toolKind, options.binding, blockedReason)
        };
    }
    if (!requiresWriteAssertion) {
        return { allowed: true };
    }
    if (options.expectedRouteLedgerRoot === undefined) {
        return {
            allowed: false,
            failure: {
                code: "ROUTELEDGER_WRITE_BINDING_ASSERTION_REQUIRED",
                message: "Write tools require expectedRouteLedgerRoot.",
                details: {
                    toolName: options.toolName,
                    toolKind: options.toolKind,
                    binding: options.binding,
                    blockedReason: {
                        code: "ROUTELEDGER_WRITE_BINDING_ASSERTION_REQUIRED",
                        message: "Write tools require expectedRouteLedgerRoot."
                    },
                    recommendedNextActions: getBindingRecommendedNextActions(options.binding).concat({
                        type: "retry_with_assertion",
                        field: "expectedRouteLedgerRoot",
                        description: "Retry the write with expectedRouteLedgerRoot set to the bound routeledgerRoot."
                    })
                }
            }
        };
    }
    if (typeof options.expectedRouteLedgerRoot !== "string" ||
        options.expectedRouteLedgerRoot.trim().length === 0 ||
        !path.isAbsolute(options.expectedRouteLedgerRoot)) {
        return {
            allowed: false,
            failure: {
                code: "MCP_EXPECTED_ROUTELEDGER_ROOT_INVALID",
                message: "expectedRouteLedgerRoot must be a non-empty absolute path.",
                details: {
                    toolName: options.toolName,
                    toolKind: options.toolKind,
                    binding: options.binding,
                    blockedReason: {
                        code: "MCP_EXPECTED_ROUTELEDGER_ROOT_INVALID",
                        message: "expectedRouteLedgerRoot must be a non-empty absolute path."
                    },
                    recommendedNextActions: [
                        {
                            type: "retry_with_assertion",
                            field: "expectedRouteLedgerRoot",
                            description: "Retry with expectedRouteLedgerRoot set to the bound routeledgerRoot."
                        }
                    ],
                    expectedRouteLedgerRoot: typeof options.expectedRouteLedgerRoot === "string"
                        ? options.expectedRouteLedgerRoot
                        : null,
                    receivedType: options.expectedRouteLedgerRoot === null
                        ? "null"
                        : Array.isArray(options.expectedRouteLedgerRoot)
                            ? "array"
                            : typeof options.expectedRouteLedgerRoot,
                    receivedValue: summarizeReceivedValue(options.expectedRouteLedgerRoot)
                }
            }
        };
    }
    const normalizedExpectedRouteLedgerRoot = path.resolve(options.expectedRouteLedgerRoot);
    if (options.binding.routeledgerRoot === null ||
        !arePhysicalPathsEqualSync(normalizedExpectedRouteLedgerRoot, options.binding.routeledgerRoot)) {
        return {
            allowed: false,
            failure: {
                code: "MCP_ROUTELEDGER_ROOT_MISMATCH",
                message: "expectedRouteLedgerRoot does not match the MCP server routeledgerRoot.",
                details: {
                    toolName: options.toolName,
                    toolKind: options.toolKind,
                    binding: options.binding,
                    blockedReason: {
                        code: "MCP_ROUTELEDGER_ROOT_MISMATCH",
                        message: "expectedRouteLedgerRoot does not match the MCP server routeledgerRoot."
                    },
                    recommendedNextActions: [
                        ...getBindingRecommendedNextActions(options.binding),
                        {
                            type: "retry_with_assertion",
                            field: "expectedRouteLedgerRoot",
                            description: "Retry with expectedRouteLedgerRoot set to the bound routeledgerRoot."
                        }
                    ],
                    expectedRouteLedgerRoot: normalizedExpectedRouteLedgerRoot
                }
            }
        };
    }
    return { allowed: true };
};
