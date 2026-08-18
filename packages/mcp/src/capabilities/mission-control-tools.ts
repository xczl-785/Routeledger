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
  runtimeCompatible: boolean | null;
  accessUrl: string | null;
  projects: unknown[];
  matchingProject: unknown;
};

export type MissionControlRuntimeContext = {
  status: "running" | "running_project_unregistered" | "stopped" | "incompatible" | "unavailable" | "error";
  healthy: boolean;
  runtimeCompatible: boolean | null;
  currentProjectRegistered: boolean;
  projectCount: number;
  accessUrl: string | null;
  notice: {
    code: string;
    message: string;
    requiresUserDecision: boolean;
    accessUrl: string | null;
  } | null;
  recommendedAction: {
    type: "open_mission_control";
    tool: "open_mission_control";
    arguments: Record<string, never>;
    requiresUserDecision: true;
  } | null;
  unavailableReason?: "binding_unavailable" | "project_uninitialized";
  diagnostic?: string;
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
    expectedRuntimeIdentity?: MissionControlRuntimeIdentity;
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

const openMissionControlAction = (): NonNullable<MissionControlRuntimeContext["recommendedAction"]> => ({
  type: "open_mission_control",
  tool: "open_mission_control",
  arguments: {},
  requiresUserDecision: true
});

const notice = (
  code: string,
  message: string,
  requiresUserDecision: boolean,
  accessUrl: string | null = null
): NonNullable<MissionControlRuntimeContext["notice"]> => ({
  code,
  message,
  requiresUserDecision,
  accessUrl
});

export const buildMissionControlRuntimeContext = (
  status: MissionControlStatusResult
): MissionControlRuntimeContext => {
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
      notice: notice(
        "MISSION_CONTROL_STOPPED",
        "RouteLedger Mission Control is not running. Would you like to start it and open the current project?",
        true
      ),
      recommendedAction: openMissionControlAction()
    };
  }

  if (status.runtimeCompatible === false) {
    return {
      status: "incompatible",
      ...shared,
      accessUrl: null,
      notice: notice(
        "MISSION_CONTROL_INCOMPATIBLE",
        "An incompatible RouteLedger Mission Control is running. Would you like to replace it with the current runtime and open the current project?",
        true
      ),
      recommendedAction: openMissionControlAction()
    };
  }

  if (!currentProjectRegistered) {
    return {
      status: "running_project_unregistered",
      ...shared,
      accessUrl: null,
      notice: notice(
        "MISSION_CONTROL_PROJECT_UNREGISTERED",
        "RouteLedger Mission Control is running, but the current project is not registered. Would you like to add and open it?",
        true
      ),
      recommendedAction: openMissionControlAction()
    };
  }

  return {
    status: "running",
    ...shared,
    notice: notice(
      "MISSION_CONTROL_RUNNING",
      `RouteLedger Mission Control is running. Open it at: ${status.accessUrl}`,
      false,
      status.accessUrl
    ),
    recommendedAction: null
  };
};

export const buildUnavailableMissionControlRuntimeContext = (
  unavailableReason: "binding_unavailable" | "project_uninitialized"
): MissionControlRuntimeContext => ({
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

export const buildMissionControlRuntimeContextError = (error: unknown): MissionControlRuntimeContext => ({
  status: "error",
  healthy: false,
  runtimeCompatible: null,
  currentProjectRegistered: false,
  projectCount: 0,
  accessUrl: null,
  notice: notice(
    "MISSION_CONTROL_STATUS_ERROR",
    "RouteLedger could not inspect Mission Control status. Route work can continue.",
    false
  ),
  recommendedAction: null,
  diagnostic: error instanceof Error ? error.message : String(error)
});

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
      riskLevel: "write",
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
    }
  ),
  defineTool(
    "stop_mission_control",
    { what: "Stop the local RouteLedger UI Hub while preserving MCP and the UI project catalog." },
    objectSchema({}),
    {
      title: "Stop Mission Control",
      riskLevel: "write",
      idempotent: true,
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
