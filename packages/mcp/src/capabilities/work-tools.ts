import type {
  Actor,
  Constraint,
  DeferredItem,
  RouteLedgerService,
  Todo
} from "@routeledger/core";

import {
  adaptDeferWorkInput,
  adaptRecordConstraintInput,
  adaptRetireConstraintInput,
  adaptReviewDeferredInput,
  type DeferWorkToolInput,
  type RecordConstraintToolInput,
  type RetireConstraintToolInput,
  type ReviewDeferredToolInput
} from "../input-adapter.js";
import {
  defineTool,
  type ToolHandler,
  type ToolRegistration,
  type ToolResponse
} from "../registry/tool-contract.js";
import {
  constraintSummaryOutputSchema,
  deferredSummaryOutputSchema,
  idempotencyOutputSchema,
  todoOutputSchema,
  todoSummaryOutputSchema,
  toolOutputSchema,
  transitionEventOutputSchema,
  workItemOutputSchema
} from "../registry/output-schemas.js";

type WorkService = Pick<
  RouteLedgerService,
  | "createTodo"
  | "closeTodo"
  | "deferWork"
  | "reviewDeferred"
  | "recordConstraint"
  | "retireConstraint"
>;

type DebugLogDraft = {
  type: string;
  projectId?: string;
  versionId?: string;
  deferredId?: string;
  constraintId?: string;
  payload?: unknown;
};

export interface WorkToolDependencies {
  service: WorkService;
  actor: Actor;
  appendDebugLog: (toolName: string, draft: DebugLogDraft) => Promise<void>;
  summarizeTodoForAgent: (todo: Todo) => Record<string, unknown>;
  summarizeDeferredForAgent: (deferred: DeferredItem) => Record<string, unknown>;
  summarizeConstraintForAgent: (constraint: Constraint) => Record<string, unknown>;
}

const stringSchema = (description: string): Record<string, unknown> => ({
  type: "string",
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

const withInputAdapter = <TInput>(
  adapter: (input: Record<string, any>) => TInput,
  handler: (input: TInput) => Promise<ToolResponse>
): ToolHandler => async (input) => handler(adapter(input));

const createOrCloseTodoOutputSchema = toolOutputSchema(
  objectSchema(
    {
      todo: todoOutputSchema,
      workItem: workItemOutputSchema,
      events: { type: "array", items: transitionEventOutputSchema },
      idempotency: idempotencyOutputSchema
    },
    ["todo", "workItem", "events", "idempotency"]
  )
);

const deferWorkOutputSchema = toolOutputSchema({
  oneOf: [
    objectSchema(
      {
        mode: { type: "string", const: "new" },
        deferred: deferredSummaryOutputSchema,
        idempotency: idempotencyOutputSchema
      },
      ["mode", "deferred", "idempotency"]
    ),
    objectSchema(
      {
        mode: { type: "string", const: "todo" },
        todo: todoSummaryOutputSchema,
        deferred: deferredSummaryOutputSchema,
        idempotency: idempotencyOutputSchema
      },
      ["mode", "todo", "deferred", "idempotency"]
    )
  ]
});

const reviewDeferredOutputSchema = toolOutputSchema(
  objectSchema(
    {
      action: {
        type: "string",
        enum: ["activate", "defer_again", "resolve"]
      },
      deferred: deferredSummaryOutputSchema,
      todo: todoSummaryOutputSchema,
      idempotency: idempotencyOutputSchema
    },
    ["action", "deferred", "idempotency"]
  )
);

const constraintWriteOutputSchema = toolOutputSchema(
  objectSchema(
    {
      constraint: constraintSummaryOutputSchema,
      idempotency: idempotencyOutputSchema
    },
    ["constraint", "idempotency"]
  )
);

export const createWorkTools = (
  dependencies: WorkToolDependencies
): ToolRegistration[] => {
  const {
    service,
    actor,
    appendDebugLog,
    summarizeTodoForAgent,
    summarizeDeferredForAgent,
    summarizeConstraintForAgent
  } = dependencies;

  return [
    defineTool(
      "create_todo",
      { what: "Create a Todo for current work." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          versionId: stringSchema("Owning version ID."),
          title: stringSchema("Todo title."),
          description: stringSchema("Optional todo description."),
          idempotencyKey: stringSchema(
            "Caller-stable key for persistent create_todo retry across response loss and restart."
          )
        },
        ["projectId", "versionId", "title", "idempotencyKey"]
      ),
      {
        title: "Create Todo",
        riskLevel: "write",
        idempotent: true,
        outputSchema: createOrCloseTodoOutputSchema
      },
      async (input) => ({
        ok: true,
        data: await service.createTodo({
          projectId: input.projectId,
          versionId: input.versionId,
          title: input.title,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
          actor
        })
      })
    ),
    defineTool(
      "close_todo",
      { what: "Close a Todo with its outcome." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          todoId: stringSchema("Todo ID."),
          reason: stringSchema("Close reason."),
          note: stringSchema("Close note."),
          idempotencyKey: stringSchema(
            "Caller-stable key for persistent close_todo retry."
          )
        },
        ["projectId", "todoId", "reason", "note", "idempotencyKey"]
      ),
      {
        title: "Close Todo",
        riskLevel: "write",
        destructive: true,
        idempotent: true,
        outputSchema: createOrCloseTodoOutputSchema
      },
      async (input) => ({
        ok: true,
        data: await service.closeTodo({
          projectId: input.projectId,
          todoId: input.todoId,
          reason: input.reason,
          note: input.note,
          idempotencyKey: input.idempotencyKey,
          actor
        })
      })
    ),
    defineTool(
      "defer_work",
      {
        what: "Create Deferred work for a future review.",
        parameter: "mode, targetReviewVersionId, and Todo or new-work fields"
      },
      objectSchema(
        {
          mode: {
            type: "string",
            enum: ["new", "todo"],
            description:
              "new creates Deferred work; todo converts an existing Todo into Deferred work."
          },
          projectId: stringSchema("RouteLedger project ID."),
          currentVersionId: stringSchema(
            "Required for mode=new. The current version where this work was identified."
          ),
          targetReviewVersionId: stringSchema(
            "Downstream version where this Deferred work must be reviewed."
          ),
          title: stringSchema("Required for mode=new. Deferred work title."),
          description: stringSchema("Optional description for mode=new."),
          todoId: stringSchema("Required for mode=todo. Existing Todo ID."),
          reason: stringSchema("Why the work is being deferred."),
          note: stringSchema(
            "Required for mode=todo. Operator note explaining the Todo transition."
          ),
          reviewTrigger: stringSchema(
            "Optional condition or evidence that should trigger review."
          ),
          idempotencyKey: stringSchema(
            "Caller-stable key for persistent defer_work retry."
          )
        },
        ["mode", "projectId", "targetReviewVersionId", "reason", "idempotencyKey"]
      ),
      {
        title: "Defer Work",
        riskLevel: "write",
        idempotent: true,
        outputSchema: deferWorkOutputSchema
      },
      withInputAdapter<DeferWorkToolInput>(adaptDeferWorkInput, async (input) => {
        const result =
          input.mode === "new"
            ? await service.deferWork({
                mode: "new",
                projectId: input.projectId,
                originVersionId: input.currentVersionId,
                targetReviewVersionId: input.targetReviewVersionId,
                title: input.title,
                description: input.description,
                reason: input.reason,
                reviewTrigger: input.reviewTrigger,
                idempotencyKey: input.idempotencyKey,
                actor
              })
            : await service.deferWork({
                mode: "todo",
                projectId: input.projectId,
                todoId: input.todoId,
                targetReviewVersionId: input.targetReviewVersionId,
                reason: input.reason,
                note: input.note,
                reviewTrigger: input.reviewTrigger,
                idempotencyKey: input.idempotencyKey,
                actor
              });
        if (!result.idempotency?.replayed) await appendDebugLog("defer_work", {
          type: "deferred.created",
          projectId: input.projectId,
          versionId: result.deferred.targetReviewVersionId,
          deferredId: result.deferred.id,
          payload: {
            mode: result.mode,
            deferredId: result.deferred.id,
            status: result.deferred.status,
            targetReviewVersionId: result.deferred.targetReviewVersionId
          }
        });
        return {
          ok: true,
          data:
            result.mode === "todo"
              ? {
                  mode: result.mode,
                  todo: summarizeTodoForAgent(result.todo),
                  deferred: summarizeDeferredForAgent(result.deferred),
                  idempotency: result.idempotency
                }
              : {
                  mode: result.mode,
                  deferred: summarizeDeferredForAgent(result.deferred),
                  idempotency: result.idempotency
                }
        };
      })
    ),
    defineTool(
      "review_deferred",
      {
        what: "Review Deferred work: activate, defer again, or resolve.",
        parameter: "deferredId and action"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          deferredId: stringSchema("Deferred item ID."),
          action: {
            type: "string",
            enum: ["activate", "defer_again", "resolve"],
            description: "Review action."
          },
          targetVersionId: stringSchema(
            "Required for activate. Version where the activated Todo will run."
          ),
          targetReviewVersionId: stringSchema(
            "Required for defer_again. Later version where review must happen."
          ),
          outcome: {
            type: "string",
            enum: ["superseded", "rejected", "out_of_scope"],
            description: "Required for resolve."
          },
          reason: stringSchema("Reason for this review decision."),
          note: stringSchema("Optional operator note."),
          reviewTrigger: stringSchema("Optional updated review trigger for defer_again."),
          decisionRef: stringSchema(
            "Decision reference. Required by the service for rejected and out_of_scope outcomes."
          ),
          idempotencyKey: stringSchema(
            "Caller-stable key for persistent review_deferred retry."
          )
        },
        ["projectId", "deferredId", "action", "reason", "idempotencyKey"]
      ),
      {
        title: "Review Deferred",
        riskLevel: "write",
        destructive: true,
        idempotent: true,
        outputSchema: reviewDeferredOutputSchema
      },
      withInputAdapter<ReviewDeferredToolInput>(adaptReviewDeferredInput, async (input) => {
        const result =
          input.action === "activate"
            ? await service.reviewDeferred({ ...input, actor })
            : input.action === "defer_again"
              ? await service.reviewDeferred({ ...input, actor })
              : await service.reviewDeferred({ ...input, actor });
        if (!result.idempotency?.replayed) await appendDebugLog("review_deferred", {
          type: `deferred.${input.action}`,
          projectId: input.projectId,
          deferredId: input.deferredId,
          payload: {
            action: input.action,
            deferredId: input.deferredId,
            status: result.deferred.status,
            resolutionOutcome: result.deferred.resolutionOutcome,
            targetReviewVersionId: result.deferred.targetReviewVersionId
          }
        });
        return {
          ok: true,
          data:
            result.action === "activate"
              ? {
                  action: result.action,
                  deferred: summarizeDeferredForAgent(result.deferred),
                  todo: summarizeTodoForAgent(result.todo),
                  idempotency: result.idempotency
                }
              : {
                  action: result.action,
                  deferred: summarizeDeferredForAgent(result.deferred),
                  idempotency: result.idempotency
                }
        };
      })
    ),
    defineTool(
      "record_constraint",
      {
        what: "Record a RouteLedger constraint.",
        parameter: "rule, rationale, and scopeType"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          rule: stringSchema("The rule that must not be violated."),
          rationale: stringSchema("Why this constraint exists."),
          scopeType: {
            type: "string",
            enum: ["project", "version"],
            description: "project applies everywhere; version applies only to versionId."
          },
          versionId: stringSchema("Required when scopeType=version."),
          idempotencyKey: stringSchema(
            "Caller-stable key for persistent record_constraint retry."
          )
        },
        ["projectId", "rule", "rationale", "scopeType", "idempotencyKey"]
      ),
      {
        title: "Record Constraint",
        riskLevel: "write",
        idempotent: true,
        outputSchema: constraintWriteOutputSchema
      },
      withInputAdapter<RecordConstraintToolInput>(adaptRecordConstraintInput, async (input) => {
        const result = await service.recordConstraint({
          projectId: input.projectId,
          rule: input.rule,
          rationale: input.rationale,
          scope:
            input.scopeType === "project"
              ? { type: "project" }
              : { type: "version", versionId: input.versionId },
          idempotencyKey: input.idempotencyKey,
          actor
        });
        if (!result.idempotency?.replayed) await appendDebugLog("record_constraint", {
          type: "constraint.recorded",
          projectId: input.projectId,
          versionId: input.scopeType === "version" ? input.versionId : undefined,
          constraintId: result.constraint.id,
          payload: {
            constraintId: result.constraint.id,
            status: result.constraint.status,
            scope: result.constraint.scope
          }
        });
        return {
          ok: true,
          data: {
            constraint: summarizeConstraintForAgent(result.constraint),
            idempotency: result.idempotency
          }
        };
      })
    ),
    defineTool(
      "retire_constraint",
      { what: "Retire an obsolete constraint." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          constraintId: stringSchema("Constraint ID."),
          reason: stringSchema("Why this constraint no longer applies."),
          note: stringSchema("Operator note for the retirement audit."),
          idempotencyKey: stringSchema(
            "Caller-stable key for persistent retire_constraint retry."
          )
        },
        ["projectId", "constraintId", "reason", "note", "idempotencyKey"]
      ),
      {
        title: "Retire Constraint",
        riskLevel: "write",
        destructive: true,
        idempotent: true,
        outputSchema: constraintWriteOutputSchema
      },
      withInputAdapter<RetireConstraintToolInput>(adaptRetireConstraintInput, async (input) => {
        const result = await service.retireConstraint({ ...input, actor });
        if (!result.idempotency?.replayed) await appendDebugLog("retire_constraint", {
          type: "constraint.retired",
          projectId: input.projectId,
          constraintId: input.constraintId,
          payload: { constraintId: result.constraint.id, status: result.constraint.status }
        });
        return {
          ok: true,
          data: {
            constraint: summarizeConstraintForAgent(result.constraint),
            idempotency: result.idempotency
          }
        };
      })
    )
  ];
};
