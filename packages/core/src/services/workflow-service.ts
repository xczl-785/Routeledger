import type { Actor } from "../domain/actor.js";
import type { ConstraintScope } from "../domain/constraint.js";
import type { DeferredItem } from "../domain/deferred-item.js";
import { DomainError } from "../domain/errors.js";
import type { Todo } from "../domain/todo.js";
import type { WorkItem } from "../domain/work-item.js";
import {
  createConstraint,
  retireConstraint,
  type ConstraintCreation,
  type ConstraintRetirement
} from "./constraint-service.js";
import {
  activateDeferred,
  createDeferred,
  deferAgain,
  deferTodo,
  resolveDeferred,
  type DeferredActivation,
  type DeferredCreation,
  type DeferredResolution,
  type DeferredResolveOutcome,
  type DeferredUpdate,
  type TodoToDeferredConversion
} from "./deferred-service.js";
import type { DomainDependencies } from "./operation.js";

export interface ApplicationResolvedTodoDeferRecords {
  todo: Todo;
  workItem: WorkItem;
}

export interface ApplicationResolvedDeferredReviewRecords {
  deferred: DeferredItem;
  workItem: WorkItem;
}

interface WorkflowContext {
  actor: Actor;
  deps: DomainDependencies;
}

export interface DeferNewWorkInput extends WorkflowContext {
  mode: "new";
  projectId: string;
  currentVersionId: string;
  title: string;
  description?: string;
  targetReviewVersionId: string;
  reason: string;
  reviewTrigger?: string | null;
}

export interface DeferTodoWorkInput extends WorkflowContext {
  mode: "todo";
  resolvedRecords: ApplicationResolvedTodoDeferRecords;
  targetReviewVersionId: string;
  reason: string;
  note: string;
  reviewTrigger?: string | null;
}

export type DeferWorkInput = DeferNewWorkInput | DeferTodoWorkInput;

export type DeferWorkResult =
  | ({
      mode: "new";
    } & DeferredCreation)
  | ({
      mode: "todo";
    } & TodoToDeferredConversion);

const assertNever = (value: never, workflow: string): never => {
  const received = value as { action?: unknown; mode?: unknown };

  throw new DomainError(
    "INVALID_DEFERRED_TRANSITION",
    `${workflow} 收到不支持的动作`,
    {
      action: received.action,
      mode: received.mode
    }
  );
};

const requireResolvedDeferredRecords = (
  value: unknown
): ApplicationResolvedDeferredReviewRecords => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("deferred" in value) ||
    !("workItem" in value) ||
    typeof value.deferred !== "object" ||
    value.deferred === null ||
    typeof value.workItem !== "object" ||
    value.workItem === null
  ) {
    throw new DomainError(
      "MISSING_REQUIRED_FIELD",
      "reviewDeferred 必须提供 application 已解析的 Deferred 与 WorkItem records"
    );
  }

  return value as unknown as ApplicationResolvedDeferredReviewRecords;
};

export const deferWork = (input: DeferWorkInput): DeferWorkResult => {
  switch (input.mode) {
    case "new": {
      const result = createDeferred({
        projectId: input.projectId,
        originVersionId: input.currentVersionId,
        targetReviewVersionId: input.targetReviewVersionId,
        title: input.title,
        description: input.description,
        reason: input.reason,
        reviewTrigger: input.reviewTrigger,
        actor: input.actor,
        deps: input.deps
      });

      return {
        mode: "new",
        ...result
      };
    }
    case "todo": {
      const result = deferTodo({
        todo: input.resolvedRecords.todo,
        workItem: input.resolvedRecords.workItem,
        targetReviewVersionId: input.targetReviewVersionId,
        reason: input.reason,
        note: input.note,
        reviewTrigger: input.reviewTrigger,
        actor: input.actor,
        deps: input.deps
      });

      return {
        mode: "todo",
        ...result
      };
    }
    default:
      return assertNever(input, "deferWork");
  }
};

interface ReviewDeferredBase extends WorkflowContext {
  resolvedRecords: ApplicationResolvedDeferredReviewRecords;
}

export interface ActivateDeferredReviewInput extends ReviewDeferredBase {
  action: "activate";
  targetVersionId: string;
  reason: string;
  note?: string;
}

export interface DeferAgainReviewInput extends ReviewDeferredBase {
  action: "defer_again";
  targetReviewVersionId: string;
  reason: string;
  note?: string;
  reviewTrigger?: string | null;
}

export interface ResolveDeferredReviewInput extends ReviewDeferredBase {
  action: "resolve";
  outcome: DeferredResolveOutcome;
  reason: string;
  note?: string;
  decisionRef?: string | null;
}

export type ReviewDeferredInput =
  | ActivateDeferredReviewInput
  | DeferAgainReviewInput
  | ResolveDeferredReviewInput;

export type ReviewDeferredResult =
  | ({
      action: "activate";
    } & DeferredActivation)
  | ({
      action: "defer_again";
    } & DeferredUpdate)
  | ({
      action: "resolve";
    } & DeferredResolution);

export const reviewDeferred = (
  input: ReviewDeferredInput
): ReviewDeferredResult => {
  if (typeof input !== "object" || input === null) {
    throw new DomainError(
      "INVALID_DEFERRED_TRANSITION",
      "reviewDeferred 输入必须是带 action 的对象"
    );
  }

  switch (input.action) {
    case "activate": {
      const { deferred, workItem } = requireResolvedDeferredRecords(
        input.resolvedRecords
      );
      const result = activateDeferred({
        deferred,
        workItem,
        versionId: input.targetVersionId,
        reason: input.reason,
        note: input.note,
        actor: input.actor,
        deps: input.deps
      });

      return {
        action: "activate",
        ...result
      };
    }
    case "defer_again": {
      const { deferred, workItem } = requireResolvedDeferredRecords(
        input.resolvedRecords
      );
      const result = deferAgain({
        deferred,
        workItem,
        targetReviewVersionId: input.targetReviewVersionId,
        reason: input.reason,
        note: input.note,
        reviewTrigger: input.reviewTrigger,
        actor: input.actor,
        deps: input.deps
      });

      return {
        action: "defer_again",
        ...result
      };
    }
    case "resolve": {
      const { deferred, workItem } = requireResolvedDeferredRecords(
        input.resolvedRecords
      );
      const result = resolveDeferred({
        deferred,
        workItem,
        outcome: input.outcome,
        reason: input.reason,
        note: input.note,
        decisionRef: input.decisionRef,
        actor: input.actor,
        deps: input.deps
      });

      return {
        action: "resolve",
        ...result
      };
    }
    default:
      return assertNever(input, "reviewDeferred");
  }
};

export interface RecordConstraintInput extends WorkflowContext {
  projectId: string;
  rule: string;
  rationale: string;
  scope: ConstraintScope;
}

export const recordConstraint = (
  input: RecordConstraintInput
): ConstraintCreation => createConstraint(input);

export interface RetireRecordedConstraintInput extends WorkflowContext {
  constraint: Parameters<typeof retireConstraint>[0]["constraint"];
  reason: string;
  note: string;
}

export const retireRecordedConstraint = (
  input: RetireRecordedConstraintInput
): ConstraintRetirement => retireConstraint(input);
