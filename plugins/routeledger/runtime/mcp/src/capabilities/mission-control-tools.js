import { defineTool } from "../registry/tool-contract.js";
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
    defineTool("open_mission_control", { what: "Open or reuse source-mode Mission Control." }, objectSchema({
        workspaceRoot: stringSchema("Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."),
        routeledgerRoot: stringSchema("Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot."),
        devBuild: booleanSchema("When true, auto-build the UI dist if it is missing before launching the source-mode Mission Control server.")
    }), {
        title: "Open Mission Control",
        riskLevel: "read-only",
        toolKind: "diagnostic",
        visibility: "source-only"
    }, async (input) => {
        const roots = dependencies.resolveRoots(input, dependencies.readBinding());
        const missionControlSource = await dependencies.loadSourceModule();
        const result = await missionControlSource.openMissionControlSource({
            workspaceRoot: roots.workspaceRoot,
            routeledgerRoot: roots.routeledgerRoot,
            devBuild: input.devBuild === true
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
    defineTool("get_mission_control_status", { what: "Inspect source-mode Mission Control health." }, objectSchema({
        workspaceRoot: stringSchema("Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."),
        routeledgerRoot: stringSchema("Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot.")
    }), {
        title: "Get Mission Control Status",
        riskLevel: "read-only",
        toolKind: "diagnostic",
        visibility: "source-only"
    }, async (input) => {
        const roots = dependencies.resolveRoots(input, dependencies.readBinding());
        const missionControlSource = await dependencies.loadSourceModule();
        const status = await missionControlSource.getMissionControlStatus({
            workspaceRoot: roots.workspaceRoot,
            routeledgerRoot: roots.routeledgerRoot
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
    })
];
