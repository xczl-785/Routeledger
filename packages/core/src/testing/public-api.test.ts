import { describe, expect, it } from "vitest";

import * as core from "../index.js";
import {
  RouteLedgerService,
  type DeferWorkCommandInput,
  type DeferWorkCommandResult,
  type RecordConstraintCommandInput,
  type RecordConstraintCommandResult,
  type RetireConstraintCommandInput,
  type RetireConstraintCommandResult,
  type ReviewDeferredCommandInput,
  type ReviewDeferredCommandResult
} from "../index.js";

const ACTOR = {
  id: "public-api-agent",
  type: "agent" as const
};

const compilePublicApplicationContract = (
  service: RouteLedgerService
): [
  Promise<DeferWorkCommandResult>,
  Promise<ReviewDeferredCommandResult>,
  Promise<RecordConstraintCommandResult>,
  Promise<RetireConstraintCommandResult>
] => {
  const deferInput: DeferWorkCommandInput = {
    mode: "todo",
    projectId: "project-id",
    todoId: "todo-id",
    targetReviewVersionId: "review-version-id",
    reason: "Review later",
    note: "Public command accepts IDs",
    actor: ACTOR
  };
  const reviewInput: ReviewDeferredCommandInput = {
    action: "activate",
    projectId: "project-id",
    deferredId: "deferred-id",
    targetVersionId: "review-version-id",
    reason: "Activate now",
    actor: ACTOR
  };
  const recordInput: RecordConstraintCommandInput = {
    projectId: "project-id",
    rule: "Keep the route auditable",
    rationale: "Public command owns record resolution",
    scope: {
      type: "version",
      versionId: "version-id"
    },
    actor: ACTOR
  };
  const retireInput: RetireConstraintCommandInput = {
    projectId: "project-id",
    constraintId: "constraint-id",
    reason: "Superseded",
    note: "Retire by ID",
    actor: ACTOR
  };

  return [
    service.deferWork(deferInput),
    service.reviewDeferred(reviewInput),
    service.recordConstraint(recordInput),
    service.retireConstraint(retireInput)
  ];
};

describe("@routeledger/core public application API", () => {
  it("exports RouteLedgerService ID-only commands without exporting the low-level workflow facade", () => {
    expect(RouteLedgerService.prototype.deferWork).toBeTypeOf("function");
    expect(RouteLedgerService.prototype.reviewDeferred).toBeTypeOf("function");
    expect(RouteLedgerService.prototype.recordConstraint).toBeTypeOf(
      "function"
    );
    expect(RouteLedgerService.prototype.retireConstraint).toBeTypeOf(
      "function"
    );
    expect(compilePublicApplicationContract).toBeTypeOf("function");

    expect(core).not.toHaveProperty("deferWork");
    expect(core).not.toHaveProperty("reviewDeferred");
    expect(core).not.toHaveProperty("recordConstraint");
  });
});
