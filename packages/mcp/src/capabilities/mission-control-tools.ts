import { defineTool, type ToolRegistration } from "../registry/tool-contract.js";

export type MissionControlOpenResult = {
  url: string;
  projectKey?: string;
  projectId: string | null;
  pid: number;
  port: number;
  reused: boolean;
  registryPath: string;
  workspaceRoot: string;
  routeledgerRoot: string;
  browserOpened: boolean;
  browserError: string | null;
  runtimeIdentity: MissionControlRuntimeIdentity;
};

export type MissionControlRuntimeIdentity = {
  runtimePackageVersion: string;
  runtimeProfile: string;
  artifactKind: string;
  pluginVersion: string | null;
  runtimePayloadDigest: string | null;
};

export type MissionControlStatusResult = {
  registryPath: string;
  projectId: string | null;
  hub: unknown;
  healthy: boolean;
  projects: unknown[];
  matchingProject: unknown;
};

export type MissionControlSourceModule = {
  openMissionControlSource: (options: {
    workspaceRoot: string;
    routeledgerRoot: string;
    devBuild?: boolean;
    openBrowser?: boolean;
    runtimeIdentity?: MissionControlRuntimeIdentity;
  }) => Promise<MissionControlOpenResult>;
  getMissionControlStatus: (options: {
    workspaceRoot: string;
    routeledgerRoot: string;
  }) => Promise<MissionControlStatusResult>;
  stopMissionControlHub: () => Promise<{
    registryPath: string;
    stopped: boolean;
    pid: number | null;
  }>;
};

export interface MissionControlToolDependencies<TBinding> {
  readBinding: () => TBinding;
  resolveRoots: (
    input: Record<string, any>,
    binding: TBinding
  ) => { workspaceRoot: string; routeledgerRoot: string };
  loadSourceModule: () => Promise<MissionControlSourceModule>;
  runtimeIdentity: MissionControlRuntimeIdentity;
  withCurrentRuntimeContextMeta: (options: {
    meta?: Record<string, unknown>;
    data: unknown;
  }) => Record<string, unknown>;
}

const stringSchema = (description: string): Record<string, unknown> => ({
  type: "string",
  description
});

const booleanSchema = (description: string): Record<string, unknown> => ({
  type: "boolean",
  description
});

const objectSchema = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  properties,
  additionalProperties: false
});

export const createMissionControlTools = <TBinding>(
  dependencies: MissionControlToolDependencies<TBinding>
): ToolRegistration[] => [
  defineTool(
    "open_mission_control",
    { what: "Open or reuse the local RouteLedger UI Hub for the bound project." },
    objectSchema({
      workspaceRoot: stringSchema(
        "Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."
      ),
      routeledgerRoot: stringSchema(
        "Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot."
      ),
      devBuild: booleanSchema(
        "When true, auto-build the UI dist if it is missing before launching the source-mode Mission Control server."
      ),
      openBrowser: booleanSchema(
        "Open the Mission Control URL in the default browser. Defaults to true. Set false for automation."
      )
    }),
    {
      title: "Open Mission Control",
      riskLevel: "read-only",
      toolKind: "diagnostic",
      visibility: "default"
    },
    async (input) => {
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
    }
  ),
  defineTool(
    "get_mission_control_status",
    { what: "Inspect the local RouteLedger UI Hub and registered projects." },
    objectSchema({
      workspaceRoot: stringSchema(
        "Optional absolute workspaceRoot override. Defaults to the current MCP binding workspaceRoot."
      ),
      routeledgerRoot: stringSchema(
        "Optional absolute routeledgerRoot override. Defaults to the current MCP binding routeledgerRoot."
      )
    }),
    {
      title: "Get Mission Control Status",
      riskLevel: "read-only",
      toolKind: "diagnostic",
      visibility: "default"
    },
    async (input) => {
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
    }
  ),
  defineTool(
    "stop_mission_control",
    { what: "Stop the local RouteLedger UI Hub while preserving MCP and the UI project catalog." },
    objectSchema({}),
    {
      title: "Stop Mission Control",
      riskLevel: "read-only",
      toolKind: "diagnostic",
      visibility: "default"
    },
    async () => {
      const missionControlSource = await dependencies.loadSourceModule();
      const result = await missionControlSource.stopMissionControlHub();
      return {
        ok: true,
        data: result,
        meta: dependencies.withCurrentRuntimeContextMeta({ data: null })
      };
    }
  )
];
