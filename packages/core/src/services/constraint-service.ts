import type { Actor } from "../domain/actor.js";
import type {
  Constraint,
  ConstraintScope
} from "../domain/constraint.js";
import { DomainError } from "../domain/errors.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import { createDomainContext, type DomainDependencies } from "./operation.js";
import { createTransitionEvents } from "./transition-event-service.js";
import { assertConstraintInvariant } from "./deferred-constraint-invariants.js";

const assertRequired = (value: string, field: string, action: string): void => {
  if (value.trim().length === 0) {
    throw new DomainError(
      "MISSING_REQUIRED_FIELD",
      `${action} 必须提供 ${field}`
    );
  }
};

const assertScope = (scope: ConstraintScope): void => {
  if (scope.type === "version") {
    assertRequired(scope.versionId, "scope.version_id", "create constraint");
  }
};

export interface CreateConstraintInput {
  projectId: string;
  rule: string;
  rationale: string;
  scope: ConstraintScope;
  actor: Actor;
  deps: DomainDependencies;
}

export interface ConstraintCreation {
  constraint: Constraint;
  events: TransitionEvent[];
}

export const createConstraint = ({
  projectId,
  rule,
  rationale,
  scope,
  actor,
  deps
}: CreateConstraintInput): ConstraintCreation => {
  assertRequired(rule, "rule", "create constraint");
  assertRequired(rationale, "rationale", "create constraint");
  assertScope(scope);

  const context = createDomainContext(deps, actor);
  const constraint: Constraint = {
    id: deps.idGenerator.nextId(),
    projectId,
    rule,
    rationale,
    scope,
    status: "active",
    createdBy: actor,
    createdAt: context.now,
    updatedAt: context.now,
    retiredAt: null,
    retireReason: null,
    retireNote: null
  };

  assertConstraintInvariant(constraint);

  return {
    constraint,
    events: createTransitionEvents(
      [
        {
          targetType: "constraint",
          targetId: constraint.id,
          eventType: "constraint.created",
          toState: constraint.status,
          metadata: {
            constraintId: constraint.id,
            scope
          }
        }
      ],
      {
        projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};

export interface RetireConstraintInput {
  constraint: Constraint;
  reason: string;
  note: string;
  actor: Actor;
  deps: DomainDependencies;
}

export interface ConstraintRetirement {
  constraint: Constraint;
  events: TransitionEvent[];
}

export const retireConstraint = ({
  constraint,
  reason,
  note,
  actor,
  deps
}: RetireConstraintInput): ConstraintRetirement => {
  if (constraint.status !== "active") {
    throw new DomainError(
      "INVALID_CONSTRAINT_TRANSITION",
      "constraint 仅允许从 active -> retired",
      {
        constraintId: constraint.id,
        status: constraint.status
      }
    );
  }

  assertRequired(reason, "reason", "retire constraint");
  assertRequired(note, "note", "retire constraint");

  const context = createDomainContext(deps, actor);
  const updatedConstraint: Constraint = {
    ...constraint,
    status: "retired",
    updatedAt: context.now,
    retiredAt: context.now,
    retireReason: reason,
    retireNote: note
  };

  assertConstraintInvariant(updatedConstraint);

  return {
    constraint: updatedConstraint,
    events: createTransitionEvents(
      [
        {
          targetType: "constraint",
          targetId: constraint.id,
          eventType: "constraint.retired",
          fromState: constraint.status,
          toState: updatedConstraint.status,
          note,
          metadata: {
            constraintId: constraint.id,
            reason
          }
        }
      ],
      {
        projectId: constraint.projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};
