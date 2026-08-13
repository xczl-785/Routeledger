import type { Actor, RouteLedgerService } from "@routeledger/core";

import type { RouteLedgerBindingPlanResult } from "../binding-assist.js";
import type { RouteLedgerBindingSummary } from "../binding.js";
import { defineTool, type ToolRegistration } from "../registry/tool-contract.js";

type HostProfile = "generic" | "codex" | "claude-code" | "cursor";

export interface PendingSessionRebind {
  workspaceRoot: string;
  routeledgerRoot: string;
  previousBinding: RouteLedgerBindingSummary;
  bindingPlan: RouteLedgerBindingPlanResult;
  requiresInit: boolean;
}

type BindingOperations = {
  discoverRouteLedgerRoots: (options: { workspaceRoot?: string }) => Promise<unknown>;
  planRouteLedgerBinding: (options: {
    binding: RouteLedgerBindingSummary;
    workspaceRoot?: string;
    routeledgerRoot?: string;
    hostProfile: HostProfile;
  }) => Promise<RouteLedgerBindingPlanResult>;
  renderHostBindingConfig: (options: {
    binding: RouteLedgerBindingSummary;
    workspaceRoot?: string;
    routeledgerRoot?: string;
    routeLedgerWorkspaceRoot?: string;
    serverName?: string;
    existingConfigStrategy?: "write-fragment" | "overwrite" | "error";
  }) => Promise<unknown>;
  writeHostBindingConfig: (options: {
    binding: RouteLedgerBindingSummary;
    workspaceRoot?: string;
    routeledgerRoot?: string;
    routeLedgerWorkspaceRoot?: string;
    serverName?: string;
    outputPath?: string;
    existingConfigStrategy?: "write-fragment" | "overwrite" | "error";
  }) => Promise<unknown>;
};

export interface BindingAssistToolDependencies {
  readBinding: () => RouteLedgerBindingSummary;
  hostProfile: HostProfile;
  withCurrentRuntimeContextMeta: (options: {
    meta?: Record<string, unknown>;
    data: unknown;
  }) => Record<string, unknown>;
  stagePendingSessionRebind: (pending: PendingSessionRebind) => void;
  operations: BindingOperations;
}

type BootstrapService = Pick<
  RouteLedgerService,
  "initProject" | "setProjectContentLocale"
>;

export interface ProjectBootstrapToolDependencies {
  service: BootstrapService;
  actor: Actor;
}

const stringSchema = (description: string): Record<string, unknown> => ({
  type: "string",
  description
});

const booleanSchema = (description: string): Record<string, unknown> => ({
  type: "boolean",
  description
});

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {})
});

const firstVersionSchema = objectSchema(
  {
    title: stringSchema("Title of the first real Version."),
    description: stringSchema("Optional first Version description."),
    initialTodos: {
      type: "array",
      description:
        "Initial Todo titles. The field is required and may be an empty array.",
      items: stringSchema("Todo title.")
    }
  },
  ["title", "initialTodos"]
);

const optionalSourceWorkspaceRoot = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const createBindingAssistTools = (
  dependencies: BindingAssistToolDependencies
): ToolRegistration[] => {
  const {
    readBinding,
    hostProfile,
    withCurrentRuntimeContextMeta,
    stagePendingSessionRebind,
    operations
  } = dependencies;

  return [
    defineTool(
      "discover_routeledger_roots",
      {
        what: "Find .routeledger candidates under a workspace.",
        when: "inspecting an unbound workspace",
        parameter: "workspaceRoot"
      },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute host workspaceRoot. It is required when the current binding only knows an untrusted process cwd."
        )
      }),
      {
        title: "Discover RouteLedger Roots",
        riskLevel: "read-only",
        toolKind: "discovery"
      },
      async (input) => {
        const binding = readBinding();
        return {
          ok: true,
          data: await operations.discoverRouteLedgerRoots({
            workspaceRoot:
              input.workspaceRoot ??
              (binding.workspaceRootConfidence === "low" ||
              binding.workspaceRootConfidence === "none"
                ? undefined
                : binding.workspaceRoot ?? undefined)
          }),
          meta: withCurrentRuntimeContextMeta({ data: null })
        };
      }
    ),
    defineTool(
      "plan_routeledger_binding",
      {
        what: "Plan a RouteLedger binding without activating it.",
        parameter: "workspaceRoot and routeledgerRoot"
      },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute host workspaceRoot. It is required when the current binding only knows an untrusted process cwd."
        ),
        routeledgerRoot: stringSchema(
          "Optional absolute routeledgerRoot to plan. When omitted, the tool uses the current binding or a discovered single candidate."
        )
      }),
      {
        title: "Plan RouteLedger Binding",
        riskLevel: "read-only",
        toolKind: "planning"
      },
      async (input) => ({
        ok: true,
        data: await operations.planRouteLedgerBinding({
          binding: readBinding(),
          workspaceRoot: input.workspaceRoot,
          routeledgerRoot: input.routeledgerRoot,
          hostProfile
        }),
        meta: withCurrentRuntimeContextMeta({ data: null })
      })
    ),
    defineTool(
      "activate_routeledger_binding",
      {
        what: "Activate an explicit MCP binding.",
        parameter: "workspaceRoot",
        warning:
          "switching an established Codex session requires confirmProjectSwitch=true"
      },
      objectSchema(
        {
          workspaceRoot: stringSchema("Required absolute host workspaceRoot."),
          routeledgerRoot: stringSchema(
            "Optional absolute RouteLedger root inside workspaceRoot. Defaults to workspaceRoot."
          ),
          confirmProjectSwitch: booleanSchema(
            "Set true only after the user explicitly confirms replacing an established Codex session binding."
          )
        },
        ["workspaceRoot"]
      ),
      {
        title: "Activate RouteLedger Binding",
        riskLevel: "write",
        toolKind: "planning",
        recommendedApprovalMode: "prompt"
      },
      async (input) => {
        const previousBinding = readBinding();
        const canBootstrap =
          previousBinding.status === "unbound" ||
          previousBinding.status === "invalid" ||
          previousBinding.workspaceRootConfidence === "low" ||
          previousBinding.workspaceRootConfidence === "none";
        const canConfirmCodexSwitch =
          hostProfile === "codex" && input.confirmProjectSwitch === true;
        if (!canBootstrap && !canConfirmCodexSwitch) {
          return {
            ok: true,
            data: {
              status: "blocked",
              code:
                previousBinding.status === "bound" &&
                previousBinding.workspaceRootConfidence === "high"
                  ? "HIGH_CONFIDENCE_BINDING_SWITCH_REFUSED"
                  : "BINDING_BOOTSTRAP_NOT_ALLOWED",
              message:
                "An established project binding requires an explicit Codex session switch confirmation.",
              previousBinding,
              recommendedNextActions: [
                {
                  type: "confirm_session_binding_switch",
                  tool: "activate_routeledger_binding",
                  description:
                    "After explicit user confirmation, retry with the exact target roots and confirmProjectSwitch=true.",
                  requiredFields: [
                    "workspaceRoot",
                    "routeledgerRoot",
                    "confirmProjectSwitch"
                  ],
                  requiresUserDecision: true,
                  toolInput: {
                    workspaceRoot: input.workspaceRoot,
                    routeledgerRoot: input.routeledgerRoot ?? input.workspaceRoot,
                    confirmProjectSwitch: true
                  }
                }
              ]
            },
            meta: withCurrentRuntimeContextMeta({ data: null })
          };
        }

        const bindingPlan = await operations.planRouteLedgerBinding({
          binding: previousBinding,
          workspaceRoot: input.workspaceRoot,
          routeledgerRoot: input.routeledgerRoot ?? input.workspaceRoot,
          hostProfile
        });
        if (
          (bindingPlan.status !== "ready" && bindingPlan.status !== "needs_init") ||
          bindingPlan.targetBinding === null
        ) {
          return {
            ok: true,
            data: { status: "blocked", bindingPlan },
            meta: withCurrentRuntimeContextMeta({ data: null })
          };
        }

        const pending = {
          workspaceRoot: bindingPlan.targetBinding.workspaceRoot,
          routeledgerRoot: bindingPlan.targetBinding.routeledgerRoot,
          previousBinding,
          bindingPlan,
          requiresInit: bindingPlan.requiresInit
        };
        stagePendingSessionRebind(pending);
        return {
          ok: true,
          data: {
            status: "pending_session_rebind",
            previousBinding,
            requiresInit: bindingPlan.requiresInit,
            bindingPlan
          }
        };
      }
    ),
    defineTool(
      "render_host_binding_config",
      { what: "Render a Codex binding config or fragment." },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute host workspaceRoot. Required when the current binding only knows an untrusted process cwd."
        ),
        routeledgerRoot: stringSchema(
          "Optional absolute routeledgerRoot to render. When omitted, the tool uses the current binding or a discovered single candidate."
        ),
        routeLedgerWorkspaceRoot: stringSchema(
          "Optional absolute RouteLedger source repo root used as the Codex MCP cwd in source mode."
        ),
        serverName: stringSchema("Optional MCP server name override."),
        existingConfigStrategy: {
          type: "string",
          enum: ["write-fragment", "overwrite", "error"],
          description:
            "How Codex should plan the target path when .codex/config.toml already exists. The tool only renders and plans; it never writes."
        }
      }),
      {
        title: "Render Host Binding Config",
        riskLevel: "read-only",
        toolKind: "planning"
      },
      async (input) => ({
        ok: true,
        data: await operations.renderHostBindingConfig({
          binding: readBinding(),
          workspaceRoot: input.workspaceRoot,
          routeledgerRoot: input.routeledgerRoot,
          routeLedgerWorkspaceRoot: optionalSourceWorkspaceRoot(
            input.routeLedgerWorkspaceRoot
          ),
          serverName: input.serverName,
          existingConfigStrategy: input.existingConfigStrategy
        }),
        meta: withCurrentRuntimeContextMeta({ data: null })
      })
    ),
    defineTool(
      "write_host_binding_config",
      {
        what: "Write a Codex binding config or fragment.",
        prerequisite: "a planned binding"
      },
      objectSchema({
        workspaceRoot: stringSchema(
          "Optional absolute host workspaceRoot. Required when the current binding only knows an untrusted process cwd."
        ),
        routeledgerRoot: stringSchema(
          "Optional absolute routeledgerRoot to write. When omitted, the tool uses the current binding or a discovered single candidate."
        ),
        routeLedgerWorkspaceRoot: stringSchema(
          "Optional absolute RouteLedger source repo root used as the Codex MCP cwd in source mode."
        ),
        serverName: stringSchema("Optional MCP server name override."),
        outputPath: stringSchema(
          "Optional absolute output path. Defaults to workspaceRoot/.codex/config.toml or a routeledger fragment when config.toml already exists."
        ),
        existingConfigStrategy: {
          type: "string",
          enum: ["write-fragment", "overwrite", "error"],
          description:
            "How Codex should write when .codex/config.toml already exists. Defaults to writing a fragment instead of overwriting."
        }
      }),
      {
        title: "Write Host Binding Config",
        riskLevel: "write",
        toolKind: "planning",
        recommendedApprovalMode: "prompt"
      },
      async (input) => ({
        ok: true,
        data: await operations.writeHostBindingConfig({
          binding: readBinding(),
          workspaceRoot: input.workspaceRoot,
          routeledgerRoot: input.routeledgerRoot,
          routeLedgerWorkspaceRoot: optionalSourceWorkspaceRoot(
            input.routeLedgerWorkspaceRoot
          ),
          serverName: input.serverName,
          outputPath: input.outputPath,
          existingConfigStrategy: input.existingConfigStrategy
        }),
        meta: withCurrentRuntimeContextMeta({ data: null })
      })
    )
  ];
};

export const createProjectBootstrapTools = (
  dependencies: ProjectBootstrapToolDependencies
): ToolRegistration[] => {
  const { service, actor } = dependencies;

  return [
    defineTool(
      "init_project",
      { what: "Initialize canonical RouteLedger project data." },
      objectSchema(
        {
          name: stringSchema("Project name."),
          description: stringSchema("Optional project description."),
          contentLocale: stringSchema(
            "Concrete BCP 47 locale confirmed by the user for future project content. null and auto are not allowed."
          ),
          firstVersion: firstVersionSchema
        },
        ["name", "contentLocale"]
      ),
      {
        title: "Init Project",
        riskLevel: "write",
        toolKind: "bootstrap"
      },
      async (input) => ({
        ok: true,
        data: await service.initProject({
          name: input.name,
          description: input.description,
          contentLocale: input.contentLocale,
          firstVersion: input.firstVersion ?? null,
          actor
        })
      })
    ),
    defineTool(
      "set_project_content_locale",
      {
        what: "Set a user-confirmed content locale for an existing project.",
        parameter: "projectId, contentLocale, reason",
        warning: "Affects future writes only"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          contentLocale: stringSchema(
            "Concrete BCP 47 locale confirmed by the user. null and auto are not allowed."
          ),
          reason: stringSchema(
            "Why the project content locale was selected or changed."
          )
        },
        ["projectId", "contentLocale", "reason"]
      ),
      {
        title: "Set Project Content Locale",
        riskLevel: "write",
        recommendedApprovalMode: "prompt"
      },
      async (input) => ({
        ok: true,
        data: await service.setProjectContentLocale({
          projectId: input.projectId,
          contentLocale: input.contentLocale,
          reason: input.reason,
          actor
        })
      })
    )
  ];
};
