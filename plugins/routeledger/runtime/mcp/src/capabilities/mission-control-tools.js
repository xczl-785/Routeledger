import { defineTool } from "../registry/tool-contract.js";
const openMissionControlAction = () => ({
    type: "open_mission_control",
    tool: "open_mission_control",
    arguments: {},
    requiresUserDecision: true
});
const notice = (code, message, requiresUserDecision, accessUrl = null) => ({
    code,
    message,
    requiresUserDecision,
    accessUrl
});
export const buildMissionControlRuntimeContext = (status) => {
    const currentProjectRegistered = status.matchingProject !== null;
    const shared = {
        healthy: status.healthy,
        runtimeCompatible: status.runtimeCompatible,
        currentProjectRegistered,
        projectCount: status.projects.length,
        accessUrl: status.accessUrl
    };
    if (!status.healthy || status.hub === null) {
        return {
            status: "stopped",
            ...shared,
            notice: notice("MISSION_CONTROL_STOPPED", "RouteLedger Mission Control is not running. Would you like to start it and open the current project?", true),
            recommendedAction: openMissionControlAction()
        };
    }
    if (status.runtimeCompatible === false) {
        return {
            status: "incompatible",
            ...shared,
            accessUrl: null,
            notice: notice("MISSION_CONTROL_INCOMPATIBLE", "An incompatible RouteLedger Mission Control is running. Would you like to replace it with the current runtime and open the current project?", true),
            recommendedAction: openMissionControlAction()
        };
    }
    if (!currentProjectRegistered) {
        return {
            status: "running_project_unregistered",
            ...shared,
            accessUrl: null,
            notice: notice("MISSION_CONTROL_PROJECT_UNREGISTERED", "RouteLedger Mission Control is running, but the current project is not registered. Would you like to add and open it?", true),
            recommendedAction: openMissionControlAction()
        };
    }
    return {
        status: "running",
        ...shared,
        notice: notice("MISSION_CONTROL_RUNNING", `RouteLedger Mission Control is running. Open it at: ${status.accessUrl}`, false, status.accessUrl),
        recommendedAction: null
    };
};
export const buildUnavailableMissionControlRuntimeContext = (unavailableReason) => ({
    status: "unavailable",
    healthy: false,
    runtimeCompatible: null,
    currentProjectRegistered: false,
    projectCount: 0,
    accessUrl: null,
    notice: null,
    recommendedAction: null,
    unavailableReason
});
export const buildMissionControlRuntimeContextError = (error) => ({
    status: "error",
    healthy: false,
    runtimeCompatible: null,
    currentProjectRegistered: false,
    projectCount: 0,
    accessUrl: null,
    notice: notice("MISSION_CONTROL_STATUS_ERROR", "RouteLedger could not inspect Mission Control status. Route work can continue.", false),
    recommendedAction: null,
    diagnostic: error instanceof Error ? error.message : String(error)
});
const stringSchema = (description) => ({
    type: "string",
    description
});
const booleanSchema = (description) => ({
    type: "boolean",
    description
});
const objectSchema = (properties) => ({
    type: "object",
    properties,
    additionalProperties: false
});
export const createMissionControlTools = (dependencies) => [
    defineTool("open_mission_control", { what: "Open or reuse the local RouteLedger UI Hub for the bound project." }, objectSchema({
        workspaceRoot: stringSchema("Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."),
        routeledgerRoot: stringSchema("Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot."),
        devBuild: booleanSchema("When true, auto-build the UI dist if it is missing before launching the source-mode Mission Control server."),
        openBrowser: booleanSchema("Open the Mission Control URL in the default browser. Defaults to true. Set false for automation.")
    }), {
        title: "Open Mission Control",
        riskLevel: "write",
        toolKind: "diagnostic",
        visibility: "default"
    }, async (input) => {
        const roots = dependencies.resolveRoots(input, dependencies.readBinding());
        const missionControlSource = await dependencies.loadSourceModule();
        const result = await missionControlSource.openMissionControlSource({
            workspaceRoot: roots.workspaceRoot,
            routeledgerRoot: roots.routeledgerRoot,
            devBuild: input.devBuild === true,
            openBrowser: input.openBrowser !== false,
            runtimeIdentity: dependencies.runtimeIdentity
        });
        return {
            ok: true,
            data: result,
            meta: dependencies.withCurrentRuntimeContextMeta({
                data: {
                    project: result.projectId === null ? null : { id: result.projectId }
                }
            })
        };
    }),
    defineTool("get_mission_control_status", { what: "Inspect the local RouteLedger UI Hub and registered projects." }, objectSchema({
        workspaceRoot: stringSchema("Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."),
        routeledgerRoot: stringSchema("Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot.")
    }), {
        title: "Get Mission Control Status",
        riskLevel: "read-only",
        toolKind: "diagnostic",
        visibility: "default"
    }, async (input) => {
        const roots = dependencies.resolveRoots(input, dependencies.readBinding());
        const missionControlSource = await dependencies.loadSourceModule();
        const status = await missionControlSource.getMissionControlStatus({
            workspaceRoot: roots.workspaceRoot,
            routeledgerRoot: roots.routeledgerRoot,
            expectedRuntimeIdentity: dependencies.runtimeIdentity
        });
        return {
            ok: true,
            data: status,
            meta: dependencies.withCurrentRuntimeContextMeta({
                data: {
                    project: status.projectId === null ? null : { id: status.projectId }
                }
            })
        };
    }),
    defineTool("stop_mission_control", { what: "Stop the local RouteLedger UI Hub while preserving MCP and the UI project catalog." }, objectSchema({}), {
        title: "Stop Mission Control",
        riskLevel: "write",
        idempotent: true,
        toolKind: "diagnostic",
        visibility: "default"
    }, async () => {
        const missionControlSource = await dependencies.loadSourceModule();
        const result = await missionControlSource.stopMissionControlHub();
        return {
            ok: true,
            data: result,
            meta: dependencies.withCurrentRuntimeContextMeta({ data: null })
        };
    })
];
