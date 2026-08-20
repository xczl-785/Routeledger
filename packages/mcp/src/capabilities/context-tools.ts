import type { Actor, ResidualAuditInput, RouteLedgerService } from "@routeledger/core";

import {
  adaptCheckDocDriftInput,
  adaptGetCurrentContextInput,
  adaptListVersionsWindowInput,
  type CheckDocDriftToolInput,
  type GetCurrentContextToolInput,
  type ListVersionsWindowToolInput
} from "../input-adapter.js";
import {
  defineTool,
  type ToolHandler,
  type ToolRegistration,
  type ToolResponse
} from "../registry/tool-contract.js";
import { residualAuditInputSchema } from "../registry/route-input-schemas.js";
import { toolOutputSchema } from "../registry/output-schemas.js";
import {
  sanitizeDocDriftForAgent,
  sanitizeVersionStructureForAgent
} from "./context-agent-projection.js";

type ContextService = Pick<
  RouteLedgerService,
  | "getCurrentContext"
  | "getNextAction"
  | "checkDocDrift"
  | "summarizeVersionCloseout"
  | "planVersionCloseout"
  | "listVersionsWindow"
  | "listVersions"
  | "checkStartGate"
  | "checkCloseGate"
  | "getVersionStructure"
  | "getVersionTransitionGuide"
>;

type DebugLogDraft = {
  type: string;
  projectId?: string;
  versionId?: string;
  payload?: unknown;
};

export interface ContextToolDependencies {
  service: ContextService;
  actor: Actor;
  appendDebugLog: (toolName: string, draft: DebugLogDraft) => Promise<void>;
  withCurrentRuntimeContextMeta: (options: {
    meta?: Record<string, unknown>;
    data: unknown;
  }) => Record<string, unknown>;
}

const stringSchema = (
  description: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({ type: "string", description, ...extra });

const integerSchema = (
  description: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({ type: "integer", description, ...extra });

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

const docDriftExpectedPointerSchema = objectSchema(
  {
    kind: stringSchema("Pointer kind label used by the caller."),
    path: stringSchema("Expected repo-relative pointer path."),
    required: booleanSchema(
      "Defaults to true. Set false to make this pointer advisory only."
    )
  },
  ["kind", "path"]
);

const withInputAdapter = <TInput>(
  adapter: (input: Record<string, any>) => TInput,
  handler: (input: TInput) => Promise<ToolResponse>
): ToolHandler => async (input) => handler(adapter(input));

const nullableStringOutputSchema = {
  anyOf: [{ type: "string" }, { type: "null" }]
};
const flexibleObjectOutputSchema = {
  type: "object",
  additionalProperties: true
};
const flexibleObjectArrayOutputSchema = {
  type: "array",
  items: flexibleObjectOutputSchema
};
const stringArrayOutputSchema = { type: "array", items: { type: "string" } };
const nullableFlexibleObjectOutputSchema = {
  anyOf: [flexibleObjectOutputSchema, { type: "null" }]
};
const projectContextOutputSchema = objectSchema(
  {
    id: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    currentVersionId: nullableStringOutputSchema,
    contentLocale: { type: "string" },
    updatedAt: { type: "string" }
  },
  ["id", "name", "status", "currentVersionId", "contentLocale", "updatedAt"]
);
const nextActionOutputSchema = objectSchema(
  {
    actionType: { type: "string" },
    recommendedTool: { anyOf: [{ type: "string" }, { type: "null" }] },
    toolInput: flexibleObjectOutputSchema,
    summary: { type: "string" },
    reason: { type: "string" },
    targetId: nullableStringOutputSchema,
    requiresL3Approval: { type: "boolean" },
    recordIds: stringArrayOutputSchema,
    blockingRiskCodes: stringArrayOutputSchema,
    choices: flexibleObjectArrayOutputSchema
  },
  [
    "actionType",
    "summary",
    "reason",
    "targetId",
    "requiresL3Approval",
    "recordIds",
    "blockingRiskCodes"
  ]
);
const sharedContextFields = {
  project: projectContextOutputSchema,
  currentVersion: nullableFlexibleObjectOutputSchema,
  nextVersion: nullableFlexibleObjectOutputSchema,
  todos: flexibleObjectArrayOutputSchema,
  currentTodos: flexibleObjectArrayOutputSchema,
  todoScopes: objectSchema(
    {
      todos: { type: "string", const: "all_open_route" },
      currentTodos: { type: "string", const: "current_version_open" }
    },
    ["todos", "currentTodos"]
  ),
  deferred: flexibleObjectArrayOutputSchema,
  constraints: flexibleObjectArrayOutputSchema,
  dueDeferred: flexibleObjectArrayOutputSchema,
  dueDeferredIds: stringArrayOutputSchema,
  unresolvedDeferredIds: stringArrayOutputSchema,
  blockedConstraintIds: stringArrayOutputSchema,
  gates: objectSchema(
    {
      start: nullableFlexibleObjectOutputSchema,
      close: nullableFlexibleObjectOutputSchema
    },
    ["start", "close"]
  ),
  pendingL3Proposals: flexibleObjectArrayOutputSchema,
  statusRisks: flexibleObjectArrayOutputSchema,
  nextAction: nextActionOutputSchema
};
const sharedContextRequired = Object.keys(sharedContextFields);
const getCurrentContextOutputSchema = toolOutputSchema(
  objectSchema(
    {
      ...sharedContextFields,
      versions: flexibleObjectArrayOutputSchema,
      legacyUndo: flexibleObjectArrayOutputSchema
    },
    [...sharedContextRequired, "versions"]
  )
);
const nextActionContextOutputSchema = toolOutputSchema(
  objectSchema(sharedContextFields, sharedContextRequired)
);

const closeoutStepOutputSchema = objectSchema(
  {
    stepId: { type: "string" },
    kind: { type: "string" },
    recommendedTool: nullableStringOutputSchema,
    targetId: nullableStringOutputSchema,
    requiredInputs: {
      type: "array",
      items: objectSchema({ field: { type: "string" }, value: {} }, ["field", "value"])
    },
    governanceLayer: { type: "string" },
    requiresL3Approval: { type: "boolean" },
    writesRouteState: { type: "boolean" },
    summary: { type: "string" },
    reason: { type: "string" },
    unlockPaths: flexibleObjectArrayOutputSchema,
    warnings: stringArrayOutputSchema
  },
  [
    "stepId",
    "kind",
    "recommendedTool",
    "targetId",
    "requiredInputs",
    "governanceLayer",
    "requiresL3Approval",
    "writesRouteState",
    "summary",
    "reason",
    "unlockPaths"
  ]
);
const planVersionCloseoutOutputSchema = toolOutputSchema(
  objectSchema(
    {
      projectId: { type: "string" },
      version: flexibleObjectOutputSchema,
      summary: flexibleObjectOutputSchema,
      status: {
        type: "string",
        enum: [
          "no_op",
          "blocked",
          "ready_to_complete",
          "ready_to_close",
          "needs_pending_decision",
          "planned"
        ]
      },
      steps: { type: "array", items: closeoutStepOutputSchema },
      warnings: stringArrayOutputSchema
    },
    ["projectId", "version", "summary", "status", "steps", "warnings"]
  )
);

export const createContextTools = (
  dependencies: ContextToolDependencies
): ToolRegistration[] => {
  const {
    service,
    actor,
    appendDebugLog,
    withCurrentRuntimeContextMeta
  } = dependencies;

  return [
    defineTool(
      "get_current_context",
      { what: "Read current project, route, work, and gate context." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          budgetBytes: integerSchema("Optional payload budget in bytes.", {
            minimum: 8192,
            maximum: 65536
          }),
          includeAllVersions: booleanSchema(
            "Return all versions instead of a current-centered window."
          ),
          versionWindowBefore: integerSchema("How many versions before current to include.", {
            minimum: 0,
            maximum: 20
          }),
          versionWindowAfter: integerSchema("How many versions after current to include.", {
            minimum: 0,
            maximum: 20
          }),
          includeLegacyUndo: booleanSchema(
            "Audit-only. Include legacy Undo records under legacyUndo when a hidden legacy blocker must be inspected. Defaults to false."
          )
        },
        ["projectId"]
      ),
      {
        title: "Get Current Context",
        riskLevel: "read-only",
        outputSchema: getCurrentContextOutputSchema
      },
      withInputAdapter<GetCurrentContextToolInput>(adaptGetCurrentContextInput, async (input) => {
        const context = await service.getCurrentContext({
          projectId: input.projectId,
          budgetBytes: input.budgetBytes,
          includeAllVersions: input.includeAllVersions,
          versionWindowBefore: input.versionWindowBefore,
          versionWindowAfter: input.versionWindowAfter,
          includeLegacyUndo: input.includeLegacyUndo
        });
        return {
          ok: true,
          data: context.data,
          meta: withCurrentRuntimeContextMeta({ meta: context.meta, data: context.data })
        };
      })
    ),
    defineTool(
      "next_action",
      { what: "Read the shared next route action." },
      objectSchema({ projectId: stringSchema("RouteLedger project ID.") }, ["projectId"]),
      {
        title: "Next Action",
        riskLevel: "read-only",
        outputSchema: nextActionContextOutputSchema
      },
      async (input) => {
        const nextAction = await service.getNextAction({ projectId: input.projectId });
        return {
          ok: true,
          data: nextAction.data,
          meta: withCurrentRuntimeContextMeta({ data: nextAction.data })
        };
      }
    ),
    defineTool(
      "check_doc_drift",
      { what: "Compare selected entry docs with RouteLedger truth.", parameter: "entryFiles" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          entryFiles: {
            type: "array",
            description:
              "Repo-relative human entry docs to inspect under the MCP server workspaceRoot.",
            items: stringSchema("Repo-relative entry doc path.")
          },
          expectedPointers: {
            type: "array",
            description:
              "Optional expected doc pointers that should appear in at least one checked file.",
            items: docDriftExpectedPointerSchema
          }
        },
        ["projectId", "entryFiles"]
      ),
      { title: "Check Doc Drift", riskLevel: "read-only" },
      withInputAdapter<CheckDocDriftToolInput>(adaptCheckDocDriftInput, async (input) => {
        const result = await service.checkDocDrift({
          projectId: input.projectId,
          entryFiles: input.entryFiles,
          expectedPointers: input.expectedPointers
        });
        return {
          ok: true,
          data: sanitizeDocDriftForAgent(result.data),
          meta: withCurrentRuntimeContextMeta({ data: result.data })
        };
      })
    ),
    defineTool(
      "summarize_version_closeout",
      { what: "Summarize a version's closeout blockers and evidence." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Optional version ID. Defaults to project.currentVersionId."),
          eventLimit: integerSchema("How many related recent events to include.", {
            minimum: 1,
            maximum: 50
          })
        },
        ["projectId"]
      ),
      { title: "Summarize Version Closeout", riskLevel: "read-only" },
      async (input) => {
        const summary = await service.summarizeVersionCloseout({
          projectId: input.projectId,
          versionId: input.versionId,
          eventLimit: input.eventLimit
        });
        await appendDebugLog("summarize_version_closeout", {
          type: "closeout.summary",
          projectId: summary.data.projectId,
          versionId: summary.data.version.id,
          payload: {
            canClose: summary.data.canClose,
            closeGateOk: summary.data.closeGate.ok,
            blockerCodes: summary.data.closeGate.blockers.map((blocker) => blocker.code),
            eventLimit: input.eventLimit ?? null
          }
        });
        return {
          ok: true,
          data: summary.data,
          meta: withCurrentRuntimeContextMeta({
            meta: {
              ...summary.meta,
              metadata: { workflowMode: "read_only", createsPendingProposal: false }
            },
            data: { project: { id: summary.data.projectId } }
          })
        };
      }
    ),
    defineTool(
      "plan_version_closeout",
      { what: "Plan concrete steps to clear a version closeout." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Optional version ID. Defaults to project.currentVersionId."),
          eventLimit: integerSchema(
            "How many related recent events to include in the embedded summary.",
            { minimum: 1, maximum: 50 }
          )
        },
        ["projectId"]
      ),
      {
        title: "Plan Version Closeout",
        riskLevel: "read-only",
        outputSchema: planVersionCloseoutOutputSchema
      },
      async (input) => {
        const plan = await service.planVersionCloseout({
          projectId: input.projectId,
          versionId: input.versionId,
          eventLimit: input.eventLimit
        });
        await appendDebugLog("plan_version_closeout", {
          type: "closeout.plan",
          projectId: plan.data.projectId,
          versionId: plan.data.version.id,
          payload: {
            status: plan.data.status,
            stepKinds: plan.data.steps.map((step) => step.kind),
            closeGateOk: plan.data.summary.closeGate.ok,
            eventLimit: input.eventLimit ?? null
          }
        });
        return {
          ok: true,
          data: plan.data,
          meta: withCurrentRuntimeContextMeta({
            meta: {
              ...plan.meta,
              metadata: { workflowMode: "read_only", createsPendingProposal: false }
            },
            data: { project: { id: plan.data.projectId } }
          })
        };
      }
    ),
    defineTool(
      "list_versions_window",
      { what: "List a compact version window." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          aroundVersionId: stringSchema(
            "Optional anchor version ID. Defaults to currentVersionId."
          ),
          before: integerSchema("How many versions before the anchor to include.", {
            minimum: 0,
            maximum: 20
          }),
          after: integerSchema("How many versions after the anchor to include.", {
            minimum: 0,
            maximum: 20
          })
        },
        ["projectId"]
      ),
      { title: "List Versions Window", riskLevel: "read-only" },
      withInputAdapter<ListVersionsWindowToolInput>(adaptListVersionsWindowInput, async (input) => {
        const window = await service.listVersionsWindow({
          projectId: input.projectId,
          aroundVersionId: input.aroundVersionId,
          before: input.before,
          after: input.after
        });
        return {
          ok: true,
          data: window.data,
          meta: withCurrentRuntimeContextMeta({ meta: window.meta, data: window.data })
        };
      })
    ),
    defineTool(
      "list_versions",
      { what: "List project versions." },
      objectSchema({ projectId: stringSchema("RouteLedger project ID.") }, ["projectId"]),
      { title: "List Versions", riskLevel: "read-only" },
      async (input) => ({ ok: true, data: await service.listVersions(input.projectId) })
    ),
    defineTool(
      "check_start_gate",
      { what: "Evaluate a version start gate." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID.")
        },
        ["projectId", "versionId"]
      ),
      { title: "Check Start Gate", riskLevel: "read-only" },
      async (input) => {
        const gate = await service.checkStartGate({
          projectId: input.projectId,
          versionId: input.versionId,
          actor
        });
        await appendDebugLog("check_start_gate", {
          type: "gate.start",
          projectId: input.projectId,
          versionId: input.versionId,
          payload: {
            allowed: gate.allowed,
            blockerCodes: gate.blockers.map((blocker) => blocker.code)
          }
        });
        return { ok: true, data: gate };
      }
    ),
    defineTool(
      "check_close_gate",
      { what: "Evaluate a version close gate." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID."),
          residualAudit: {
            ...residualAuditInputSchema,
            description:
              "Explicit reviewed residual audit for close-gate evaluation; { status: reviewed, items: [] } means reviewed-empty."
          }
        },
        ["projectId", "versionId"]
      ),
      { title: "Check Close Gate", riskLevel: "read-only" },
      async (input) => {
        const gate = await service.checkCloseGate({
          projectId: input.projectId,
          versionId: input.versionId,
          residualAudit: input.residualAudit as ResidualAuditInput,
          actor
        });
        await appendDebugLog("check_close_gate", {
          type: "gate.close",
          projectId: input.projectId,
          versionId: input.versionId,
          payload: {
            allowed: gate.allowed,
            blockerCodes: gate.blockers.map((blocker) => blocker.code),
            residualAuditCount: Array.isArray(input.residualAudit)
              ? input.residualAudit.length
              : Array.isArray((input.residualAudit as { items?: unknown } | undefined)?.items)
                ? (input.residualAudit as { items: unknown[] }).items.length
                : 0
          }
        });
        return { ok: true, data: gate };
      }
    ),
    defineTool(
      "get_version_structure",
      { what: "Read version topology and legal operation hints." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Optional focus version ID. Defaults to currentVersionId."),
          residualAudit: {
            ...residualAuditInputSchema,
            description: "Optional residual audit sample used to evaluate close_version legality."
          }
        },
        ["projectId"]
      ),
      { title: "Get Version Structure", riskLevel: "read-only" },
      async (input) => {
        const structure = await service.getVersionStructure({
          projectId: input.projectId,
          versionId: input.versionId,
          residualAudit: input.residualAudit as ResidualAuditInput
        });
        return { ok: true, data: sanitizeVersionStructureForAgent(structure) };
      }
    ),
    defineTool(
      "get_version_transition_guide",
      {
        what: "Guide a from-version to target-version transition.",
        parameter: "fromVersionId and targetVersionId"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          fromVersionId: stringSchema("Optional from version ID. Defaults to currentVersionId."),
          targetVersionId: stringSchema("Target version ID."),
          residualAudit: {
            ...residualAuditInputSchema,
            description:
              "Optional residual audit sample used to preview the from-version close gate."
          }
        },
        ["projectId", "targetVersionId"]
      ),
      { title: "Get Version Transition Guide", riskLevel: "read-only" },
      async (input) => {
        const guide = await service.getVersionTransitionGuide({
          projectId: input.projectId,
          fromVersionId: input.fromVersionId,
          targetVersionId: input.targetVersionId,
          residualAudit: input.residualAudit as ResidualAuditInput
        });
        return {
          ok: true,
          data: guide,
          meta: withCurrentRuntimeContextMeta({
            meta: {
              metadata: { workflowMode: "read_only", createsPendingProposal: false }
            },
            data: guide
          })
        };
      }
    )
  ];
};
