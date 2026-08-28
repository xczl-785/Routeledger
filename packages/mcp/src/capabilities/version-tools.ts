import {
  ApplicationError,
  BATCH_CREATE_VERSIONS_MODES,
  BATCH_PREVIOUS_CURRENT_POLICIES,
  ROUTE_OPERATION_WORKFLOW_MODES,
  isBatchCreateVersionsMode,
  isBatchPreviousCurrentPolicy,
  isRouteOperationWorkflowMode,
  type Actor,
  type BatchCreateVersionsMode,
  type BatchPreviousCurrentPolicy,
  type ResidualAuditInput,
  type RouteLedgerService
} from "@routeledger/core";

import { residualAuditInputSchema } from "../registry/route-input-schemas.js";
import { toolOutputSchema } from "../registry/output-schemas.js";
import { defineTool, type ToolRegistration } from "../registry/tool-contract.js";

type VersionService = Pick<
  RouteLedgerService,
  | "batchCreateVersions"
  | "transitionVersion"
  | "advanceToVersion"
  | "closeVersionWorkflow"
  | "shutdownVersionWorkflow"
  | "prepareVersion"
  | "markVersionComplete"
  | "createVersion"
  | "insertVersion"
  | "createChildVersion"
  | "reorderVersions"
>;

type DebugLogDraft = {
  type: string;
  projectId?: string;
  versionId?: string;
  pendingOperationId?: string;
  payload?: unknown;
};

export interface VersionToolDependencies {
  service: VersionService;
  actor: Actor;
  appendDebugLog: (toolName: string, draft: DebugLogDraft) => Promise<void>;
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

const stringArrayOutputSchema = { type: "array", items: { type: "string" } };
const gateBlockerOutputSchema = objectSchema(
  {
    code: { type: "string" },
    message: { type: "string" },
    recordIds: stringArrayOutputSchema
  },
  ["code", "message", "recordIds"]
);
const operationDigestOutputSchema = objectSchema(
  {
    algorithm: { type: "string", const: "sha256" },
    value: { type: "string" },
    payload: { type: "object", additionalProperties: true }
  },
  ["algorithm", "value", "payload"]
);
const persistedProposalGuidanceOutputSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true }
};
const previewOrProposeCloseOutputSchema = toolOutputSchema(
  objectSchema(
    {
      mode: { type: "string", enum: ["dry_run", "propose"] },
      status: { type: "string", enum: ["ready", "blocked", "confirmation_required"] },
      projectId: { type: "string" },
      versionId: { type: "string" },
      blockers: { type: "array", items: gateBlockerOutputSchema },
      unresolvedTodoIds: stringArrayOutputSchema,
      unresolvedUndoIds: stringArrayOutputSchema,
      unresolvedDeferredIds: stringArrayOutputSchema,
      blockedConstraintIds: stringArrayOutputSchema,
      proposalPersisted: { type: "boolean", const: true },
      pendingOperationId: { type: "string" },
      operationDigest: operationDigestOutputSchema,
      humanReviewText: {
        type: "string",
        description:
          "Stable human-review material for the agent to interpret or paraphrase; it is not localized user-facing project content."
      },
      recommendedNextActions: persistedProposalGuidanceOutputSchema
    },
    [
      "mode",
      "status",
      "projectId",
      "versionId",
      "blockers",
      "unresolvedTodoIds",
      "unresolvedUndoIds",
      "unresolvedDeferredIds",
      "blockedConstraintIds"
    ]
  )
);

const withPersistedProposalGuidance = <TResult extends object>(
  result: TResult,
  fallbackProjectId?: string
): TResult & {
  recommendedNextActions?: Array<Record<string, unknown>>;
} => {
  const proposalResult = result as TResult & {
    projectId?: string;
    pendingOperationId?: string;
    digest?: string;
    operationDigest?: { value: string };
    proposal?: { digest?: { value?: string } };
  };
  const projectId = proposalResult.projectId ?? fallbackProjectId;
  if (proposalResult.pendingOperationId === undefined || projectId === undefined) {
    return result;
  }

  const input = {
    projectId,
    pendingOperationId: proposalResult.pendingOperationId
  };
  const expectedOperationDigest =
    proposalResult.digest ??
    proposalResult.operationDigest?.value ??
    proposalResult.proposal?.digest?.value;
  return {
    ...result,
    recommendedNextActions: [
      {
        action: "execute_if_admitted",
        tool: "execute_route_change",
        input: {
          operation: "execute_admitted_proposal",
          ...input,
          ...(expectedOperationDigest === undefined ? {} : { expectedOperationDigest })
        }
      },
      {
        action: "approve",
        tool: "approve_l3_operation",
        input
      },
      {
        action: "reject",
        tool: "reject_l3_operation",
        input,
        requiredInputs: ["reason"]
      }
    ]
  };
};

const batchCreateVersionsAnchorSchema = objectSchema({
  parentVersionId: {
    anyOf: [
      stringSchema("Optional parent version ID for child-chain creation."),
      { type: "null" }
    ]
  },
  afterVersionId: {
    anyOf: [
      stringSchema("Optional sibling anchor inserted after this version."),
      { type: "null" }
    ]
  },
  beforeVersionId: {
    anyOf: [
      stringSchema("Optional sibling anchor inserted before this version."),
      { type: "null" }
    ]
  }
});

const batchCreateVersionsItemSchema = objectSchema(
  {
    clientKey: stringSchema("Stable client-side key for this planned version."),
    title: stringSchema("Version title."),
    description: stringSchema(
      "Version description. Field is required; use an empty string when there is no extra detail."
    ),
    initialTodos: {
      type: "array",
      description:
        "Initial todo titles created atomically with this version. Field is required and may be an empty array.",
      items: stringSchema("Todo title.")
    }
  },
  ["clientKey", "title", "description", "initialTodos"]
);

const parseBatchCreateVersionsMode = (value: unknown): BatchCreateVersionsMode => {
  if (isBatchCreateVersionsMode(value)) {
    return value;
  }

  throw new ApplicationError(
    "BATCH_CREATE_VERSIONS_MODE_INVALID",
    "batch_create_versions mode 仅支持 preflight 或 propose",
    {
      receivedMode: value ?? null,
      allowedModes: [...BATCH_CREATE_VERSIONS_MODES]
    }
  );
};

const parseBatchPreviousCurrentPolicy = (
  value: unknown
): BatchPreviousCurrentPolicy | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (isBatchPreviousCurrentPolicy(value)) {
    return value;
  }

  throw new ApplicationError(
    "BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID",
    "batch_create_versions previousCurrentPolicy 仅支持 leave_as_is 或 require_complete_or_close",
    {
      receivedPreviousCurrentPolicy: value ?? null,
      allowedPreviousCurrentPolicies: [...BATCH_PREVIOUS_CURRENT_POLICIES]
    }
  );
};

const parseRouteOperationWorkflowMode = (
  value: unknown
): "dry_run" | "propose" | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (isRouteOperationWorkflowMode(value)) {
    return value;
  }

  throw new ApplicationError(
    "ROUTE_OPERATION_WORKFLOW_MODE_INVALID",
    "workflow mode 仅支持 dry_run 或 propose",
    {
      receivedMode: value ?? null,
      allowedModes: [...ROUTE_OPERATION_WORKFLOW_MODES]
    }
  );
};

export const createVersionWorkflowTools = (
  dependencies: VersionToolDependencies
): ToolRegistration[] => {
  const { service, actor, appendDebugLog } = dependencies;

  return [
    defineTool(
      "preflight_or_propose_version_batch",
      {
        what: "Preflight or propose an atomic version batch, including append-only continuation after a closed top-level tail.",
        parameter: "mode and versions"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          mode: {
            type: "string",
            enum: ["preflight", "propose"],
            description:
              "preflight only validates; propose creates one pending L3 proposal after a successful preflight."
          },
          partialAllowed: booleanSchema(
            "Batch B only supports false; true returns a structured plan failure."
          ),
          anchor: batchCreateVersionsAnchorSchema,
          items: {
            type: "array",
            items: batchCreateVersionsItemSchema,
            description: "Ordered versions to create as one contiguous chain."
          },
          setCurrentTo: stringSchema(
            "Optional clientKey of the new version that should become current after commit."
          ),
          previousCurrentPolicy: {
            type: "string",
            enum: ["leave_as_is", "require_complete_or_close"],
            description:
              "How to treat the previous current version if setCurrentTo is provided."
          },
          reason: stringSchema("Optional proposal reason override.")
        },
        ["projectId", "mode", "items"]
      ),
      { title: "Preflight or Propose Version Batch", riskLevel: "write" },
      async (input) => ({
        ok: true,
        data: withPersistedProposalGuidance(
          await service.batchCreateVersions({
            projectId: input.projectId,
            mode: parseBatchCreateVersionsMode(input.mode),
            partialAllowed: input.partialAllowed,
            anchor: input.anchor,
            items: input.items as Array<{
              clientKey: string;
              title: string;
              description: string;
              initialTodos: string[];
            }>,
            setCurrentTo: input.setCurrentTo,
            previousCurrentPolicy: parseBatchPreviousCurrentPolicy(
              input.previousCurrentPolicy
            ),
            reason: input.reason,
            actor
          }),
          input.projectId
        )
      })
    ),
    defineTool(
      "preview_or_propose_version_transition",
      {
        what: "Binding-sensitive transition preview or proposal.",
        parameter: "mode and targetVersionId"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID."),
          mode: {
            type: "string",
            enum: ["dry_run", "propose"],
            description:
              "dry_run is a binding-sensitive preview and still requires expectedRouteLedgerRoot; propose creates exactly one next-step proposal when actionable."
          },
          reason: stringSchema("Optional proposal reason override.")
        },
        ["projectId", "versionId"]
      ),
      { title: "Preview or Propose Version Transition", riskLevel: "write" },
      async (input) => ({
        ok: true,
        data: withPersistedProposalGuidance(await service.transitionVersion({
          projectId: input.projectId,
          versionId: input.versionId,
          mode: parseRouteOperationWorkflowMode(input.mode),
          reason: input.reason,
          actor
        }))
      })
    ),
    defineTool(
      "propose_version_advance",
      {
        what: "Atomically switch to and start the ready next Version.",
        warning:
          "Blocked gates return without writing; passing gates create one L3 proposal."
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Ready target Version ID."),
          fromVersionId: stringSchema(
            "Optional expected closed current Version ID."
          ),
          reason: stringSchema("Optional proposal reason override.")
        },
        ["projectId", "versionId"]
      ),
      { title: "Propose Version Advance", riskLevel: "write" },
      async (input) => ({
        ok: true,
        data: withPersistedProposalGuidance(
          await service.advanceToVersion({
            projectId: input.projectId,
            versionId: input.versionId,
            fromVersionId: input.fromVersionId,
            reason: input.reason,
            actor
          })
        )
      })
    ),
    defineTool(
      "preview_or_propose_version_close",
      {
        what: "Binding-sensitive close preview or proposal.",
        parameter: "mode and versionId",
        warning: "proposal needs a passing gate"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID."),
          mode: {
            type: "string",
            enum: ["dry_run", "propose"],
            description:
              "dry_run is a binding-sensitive preview and still requires expectedRouteLedgerRoot; propose creates a close_version proposal only when the gate passes."
          },
          residualAudit: {
            ...residualAuditInputSchema,
            description:
              "Residual audit items used for close preflight and, when allowed, the proposal payload."
          },
          reason: stringSchema("Optional proposal reason override.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Preview or Propose Version Close",
        riskLevel: "write",
        outputSchema: previewOrProposeCloseOutputSchema
      },
      async (input) => {
        const result = await service.closeVersionWorkflow({
          projectId: input.projectId,
          versionId: input.versionId,
          mode: parseRouteOperationWorkflowMode(input.mode),
          residualAudit: input.residualAudit as ResidualAuditInput,
          reason: input.reason,
          actor
        });
        await appendDebugLog("close_version", {
          type: "version.close",
          projectId: input.projectId,
          versionId: result.versionId,
          pendingOperationId: result.pendingOperationId,
          payload: {
            status: result.status,
            mode: result.mode,
            blockerCodes: result.blockers.map((blocker) => blocker.code),
            createsPendingProposal: result.pendingOperationId !== undefined
          }
        });

        return { ok: true, data: withPersistedProposalGuidance(result) };
      }
    ),
    defineTool(
      "preview_or_propose_forced_version_shutdown",
      {
        what: "Binding-sensitive forced-close preview or proposal.",
        parameter: "mode and versionId",
        warning: "bypasses ordinary blockers"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Target version ID."),
          mode: {
            type: "string",
            enum: ["dry_run", "propose"],
            description:
              "dry_run is a binding-sensitive preview and still requires expectedRouteLedgerRoot; propose creates a shutdown_version proposal."
          },
          shutdownReason: stringSchema(
            "Required shutdown reason suffix. RouteLedger stores it as version.stateReason with a shutdown: prefix."
          ),
          reason: stringSchema(
            "Optional proposal reason override shown in audit/review surfaces."
          )
        },
        ["projectId", "versionId", "shutdownReason"]
      ),
      {
        title: "Preview or Propose Forced Version Shutdown",
        riskLevel: "high-risk"
      },
      async (input) => {
        const result = await service.shutdownVersionWorkflow({
          projectId: input.projectId,
          versionId: input.versionId,
          mode: parseRouteOperationWorkflowMode(input.mode),
          shutdownReason: input.shutdownReason,
          reason: input.reason,
          actor
        });
        await appendDebugLog("shutdown_version", {
          type: "version.shutdown",
          projectId: input.projectId,
          versionId: result.versionId,
          pendingOperationId: result.pendingOperationId,
          payload: {
            status: result.status,
            mode: result.mode,
            forced: result.forced,
            shutdownStateReason: result.shutdownStateReason,
            ordinaryCloseBlockerCodes: result.ordinaryCloseGate.blockers.map(
              (blocker) => blocker.code
            ),
            createsPendingProposal: result.pendingOperationId !== undefined
          }
        });

        return { ok: true, data: withPersistedProposalGuidance(result) };
      }
    )
  ];
};

export const createVersionMutationTools = (
  dependencies: VersionToolDependencies
): ToolRegistration[] => {
  const { service, actor } = dependencies;

  return [
    defineTool(
      "prepare_version",
      { what: "Prepare a version for execution." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Version ID.")
        },
        ["projectId", "versionId"]
      ),
      { title: "Prepare Version", riskLevel: "write", destructive: true },
      async (input) => ({
        ok: true,
        data: await service.prepareVersion({
          projectId: input.projectId,
          versionId: input.versionId,
          actor
        })
      })
    ),
    defineTool(
      "mark_version_complete",
      { what: "Mark a version complete." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Version ID.")
        },
        ["projectId", "versionId"]
      ),
      {
        title: "Mark Version Complete",
        riskLevel: "write",
        destructive: true
      },
      async (input) => ({
        ok: true,
        data: await service.markVersionComplete({
          projectId: input.projectId,
          versionId: input.versionId,
          actor
        })
      })
    ),
    defineTool(
      "propose_version_creation",
      {
        what: "Propose a top-level version, including append-only continuation after a closed top-level tail.",
        warning: "returns a pending L3 operation"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          title: stringSchema("Version title."),
          description: stringSchema("Optional version description."),
          reason: stringSchema("Optional human-review proposal reason.")
        },
        ["projectId", "title"]
      ),
      { title: "Propose Version Creation", riskLevel: "write" },
      async (input) => ({
        ok: true,
        data: await service.createVersion({
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          reason: input.reason,
          actor
        })
      })
    ),
    defineTool(
      "propose_version_insertion",
      {
        what: "Propose a sibling version insertion.",
        parameter: "sibling anchor"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          title: stringSchema("Version title."),
          description: stringSchema("Optional version description."),
          afterVersionId: stringSchema("Insert after this sibling version ID."),
          beforeVersionId: stringSchema("Insert before this sibling version ID."),
          reason: stringSchema("Optional human-review proposal reason.")
        },
        ["projectId", "title"]
      ),
      { title: "Propose Version Insertion", riskLevel: "write" },
      async (input) => ({
        ok: true,
        data: await service.insertVersion({
          projectId: input.projectId,
          title: input.title,
          description: input.description,
          afterVersionId: input.afterVersionId,
          beforeVersionId: input.beforeVersionId,
          reason: input.reason,
          actor
        })
      })
    ),
    defineTool(
      "propose_child_version_creation",
      {
        what: "Propose a child version.",
        parameter: "parentVersionId and child anchor"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          parentVersionId: stringSchema("Parent version ID."),
          title: stringSchema("Version title."),
          description: stringSchema("Optional version description."),
          afterVersionId: stringSchema("Insert after this child version ID."),
          beforeVersionId: stringSchema("Insert before this child version ID."),
          reason: stringSchema("Optional human-review proposal reason.")
        },
        ["projectId", "parentVersionId", "title"]
      ),
      { title: "Propose Child Version Creation", riskLevel: "write" },
      async (input) => ({
        ok: true,
        data: await service.createChildVersion({
          projectId: input.projectId,
          parentVersionId: input.parentVersionId,
          title: input.title,
          description: input.description,
          afterVersionId: input.afterVersionId,
          beforeVersionId: input.beforeVersionId,
          reason: input.reason,
          actor
        })
      })
    ),
    defineTool(
      "propose_version_reorder",
      {
        what: "Propose a version reorder within its parent.",
        parameter: "sibling anchor"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Version ID to move."),
          afterVersionId: stringSchema("Move after this sibling version ID."),
          beforeVersionId: stringSchema("Move before this sibling version ID."),
          reason: stringSchema("Optional human-review proposal reason.")
        },
        ["projectId", "versionId"]
      ),
      { title: "Propose Version Reorder", riskLevel: "write" },
      async (input) => ({
        ok: true,
        data: await service.reorderVersions({
          projectId: input.projectId,
          versionId: input.versionId,
          afterVersionId: input.afterVersionId,
          beforeVersionId: input.beforeVersionId,
          reason: input.reason,
          actor
        })
      })
    )
  ];
};
