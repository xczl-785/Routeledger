import { describe, expect, it } from "vitest";

import { DomainError } from "../domain/errors.js";
import {
  createConstraint,
  retireConstraint
} from "../services/constraint-service.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";

describe("constraint service", () => {
  it("创建 project scope Constraint，active 状态不产生 WorkItem", () => {
    const deps = createTestDependencies();

    const result = createConstraint({
      projectId: "project-1",
      rule: "Canonical data must remain the source of truth",
      rationale: "Read models are rebuildable",
      scope: {
        type: "project"
      },
      actor: TEST_ACTOR,
      deps
    });

    expect(result.constraint.status).toBe("active");
    expect(result.constraint.scope).toEqual({ type: "project" });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.targetType).toBe("constraint");
    expect(result.events[0]?.targetId).toBe(result.constraint.id);
    expect(result.events[0]?.metadata.constraintId).toBe(
      result.constraint.id
    );
    expect(result.events[0]?.eventType).toBe("constraint.created");
    expect("workItem" in result).toBe(false);
    expect(
      result.events.some((event) => event.targetType === "work_item")
    ).toBe(false);
  });

  it("合法 version scope Constraint 绑定指定 Version 且不占用 WorkItem", () => {
    const deps = createTestDependencies();

    const result = createConstraint({
      projectId: "project-1",
      rule: "Do not open the next scope",
      rationale: "Keep the delivery bounded",
      scope: {
        type: "version",
        versionId: "version-2"
      },
      actor: TEST_ACTOR,
      deps
    });

    expect(result.constraint.scope).toEqual({
      type: "version",
      versionId: "version-2"
    });
    expect(result.events[0]?.targetType).toBe("constraint");
    expect(result.events[0]?.targetId).toBe(result.constraint.id);
    expect("workItem" in result).toBe(false);
    expect(
      result.events.some((event) => event.targetType === "work_item")
    ).toBe(false);
  });

  it("创建 version scope Constraint 时必须提供 versionId", () => {
    const deps = createTestDependencies();

    expect(() =>
      createConstraint({
        projectId: "project-1",
        rule: "Do not open the next scope",
        rationale: "Keep the delivery bounded",
        scope: {
          type: "version",
          versionId: " "
        },
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });

  it("Constraint 创建时必须提供 rule 与 rationale", () => {
    const deps = createTestDependencies();

    expect(() =>
      createConstraint({
        projectId: "project-1",
        rule: "",
        rationale: "required",
        scope: { type: "project" },
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);

    expect(() =>
      createConstraint({
        projectId: "project-1",
        rule: "required",
        rationale: "",
        scope: { type: "project" },
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });

  it("retire Constraint 要求 reason/note 并保留退役证据", () => {
    const deps = createTestDependencies();
    const creation = createConstraint({
      projectId: "project-1",
      rule: "Do not publish before verification",
      rationale: "Avoid false release claims",
      scope: { type: "project" },
      actor: TEST_ACTOR,
      deps
    });

    expect(() =>
      retireConstraint({
        constraint: creation.constraint,
        reason: "",
        note: "evidence",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);

    expect(() =>
      retireConstraint({
        constraint: creation.constraint,
        reason: "obsolete",
        note: "",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);

    const result = retireConstraint({
      constraint: creation.constraint,
      reason: "Replaced by release policy",
      note: "decision:release-policy-v2",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.constraint.status).toBe("retired");
    expect(result.constraint.retiredAt).toBe("2026-06-27T00:00:00.000Z");
    expect(result.constraint.retireReason).toBe("Replaced by release policy");
    expect(result.constraint.retireNote).toBe("decision:release-policy-v2");
    expect(result.events[0]?.eventType).toBe("constraint.retired");
    expect(result.events[0]).toMatchObject({
      targetType: "constraint",
      targetId: result.constraint.id
    });
    expect(result.events[0]?.fromState).toBe("active");
    expect(result.events[0]?.toState).toBe("retired");
  });

  it("已 retired Constraint 不允许重复 retire", () => {
    const deps = createTestDependencies();
    const creation = createConstraint({
      projectId: "project-1",
      rule: "Do not publish before verification",
      rationale: "Avoid false release claims",
      scope: { type: "project" },
      actor: TEST_ACTOR,
      deps
    });

    expect(() =>
      retireConstraint({
        constraint: {
          ...creation.constraint,
          status: "retired"
        },
        reason: "duplicate",
        note: "duplicate",
        actor: TEST_ACTOR,
        deps
      })
    ).toThrow(DomainError);
  });
});
