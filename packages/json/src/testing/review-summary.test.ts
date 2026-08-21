import { describe, expect, it } from "vitest";

import {
  createProjectFixture,
  createTodoFixture,
  createUndoFixture,
  createVersionFixture
} from "@routeledger/core/testing";
import {
  buildProjectAggregateReviewSummary,
  RouteLedgerJsonReviewSummaryError
} from "../index.js";
import {
  createDeferredConstraintJsonSnapshot,
  createJsonCodecSnapshot
} from "./builders.js";

describe("@routeledger/json review summary", () => {
  it("aggregates semantic changes and warnings without dumping raw events", () => {
    const base = createDeferredConstraintJsonSnapshot();
    const head = structuredClone(base);

    base.project.currentVersionId = "version-2";
    base.versions = base.versions.map((version) =>
      version.id === "version-1" ? { ...version, state: "close" as const } : version
    );

    head.project.currentVersionId = "version-1";
    head.versions = [
      ...head.versions.map((version) =>
        version.id === "version-1" ? { ...version, state: "ready" as const } : version
      ),
      createVersionFixture({
        id: "version-3",
        title: "Version 3",
        order: 3,
        previousVersionId: "version-2"
      })
    ];
    head.todos = [
      ...head.todos.map((todo) =>
        todo.id === "todo-1"
          ? {
              ...todo,
              status: "closed" as const,
              closedAt: "2026-06-27T02:00:00.000Z",
              closeReason: "done"
            }
          : todo
      ),
      createTodoFixture({
        id: "todo-2",
        workItemId: "work-item-2",
        versionId: "version-3",
        title: "New todo"
      })
    ];
    head.deferredItems = [
      ...head.deferredItems.map((deferred) =>
        deferred.id === "deferred-1"
          ? {
              ...deferred,
              status: "activated" as const,
              targetReviewVersionId: "version-3"
            }
          : deferred
      ),
      {
        ...head.deferredItems[0]!,
        id: "deferred-2",
        workItemId: "work-item-2",
        title: "New deferred",
        status: "pending" as const,
        targetReviewVersionId: "version-3"
      }
    ];
    head.constraints = [
      ...head.constraints.map((constraint) =>
        constraint.id === "constraint-1"
          ? {
              ...constraint,
              status: "retired" as const,
              retiredAt: "2026-06-27T02:30:00.000Z",
              retireReason: "superseded"
            }
          : constraint
      ),
      {
        ...head.constraints[0]!,
        id: "constraint-2",
        rule: "New active constraint",
        status: "active" as const,
        retiredAt: null,
        retireReason: null
      }
    ];
    head.undos = [
      ...head.undos.map((undo) =>
        undo.id === "undo-1"
          ? {
              ...undo,
              status: "closed" as const,
              preferredResolutionVersionId: "version-3",
              closedAt: "2026-06-27T03:00:00.000Z",
              closeReason: "handled"
            }
          : undo
      ),
      createUndoFixture({
        id: "undo-2",
        workItemId: "work-item-2",
        versionId: "version-1",
        preferredResolutionVersionId: "version-1",
        title: "Self blocker"
      })
    ];
    head.pendingOperations = [
      ...head.pendingOperations.map((operation) =>
        operation.id === "pending-1"
          ? {
              ...operation,
              status: "committed" as const,
              committedAt: "2026-06-27T03:30:00.000Z"
            }
          : operation
      ),
      {
        ...head.pendingOperations[0]!,
        id: "pending-2",
        actionType: "set_current_version",
        targetId: "version-1",
        reason: "fix current pointer",
        status: "pending" as const,
        approvalArtifactId: "approval-2",
        committedAt: null,
        rejectedAt: null,
        rejectionReason: null
      }
    ];
    head.approvalArtifacts = [
      ...head.approvalArtifacts.map((artifact) =>
        artifact.id === "approval-1"
          ? {
              ...artifact,
              status: "consumed" as const,
              consumedAt: "2026-06-27T03:40:00.000Z"
            }
          : artifact
      ),
      {
        ...head.approvalArtifacts[0]!,
        id: "approval-2",
        pendingOperationId: "pending-2",
        actionType: "set_current_version",
        targetId: "version-1",
        status: "approved" as const,
        consumedAt: null
      }
    ];
    head.assets = [
      ...head.assets.map((asset) =>
        asset.id === "asset-1"
          ? {
              ...asset,
              status: "missing" as const,
              relativePath: "docs/renamed-json-contract.md"
            }
          : asset
      ),
      {
        ...head.assets[0]!,
        id: "asset-2",
        workItemIds: ["work-item-2"],
        relativePath: "docs/review-summary.md",
        status: "active" as const
      }
    ];
    head.events = [
      ...head.events,
      {
        ...head.events[0]!,
        id: "event-2",
        eventType: "version.reopened",
        targetType: "version",
        targetId: "version-1"
      },
      {
        ...head.events[0]!,
        id: "event-3",
        eventType: "pending_operation.committed",
        targetId: "pending-1"
      },
      {
        ...head.events[0]!,
        id: "event-4",
        eventType: "approval_artifact.approved",
        targetType: "approval_artifact",
        targetId: "approval-2"
      }
    ];

    const summary = buildProjectAggregateReviewSummary(base, head, {
      baseLabel: "HEAD~1",
      headLabel: "HEAD"
    });

    expect(summary.overview).toMatchObject({
      baseRef: "HEAD~1",
      headRef: "HEAD",
      projectId: "project-1",
      hasSemanticChanges: true
    });
    expect(summary.versions).toMatchObject({
      createdCount: 1,
      stateChangedCount: 1,
      currentPointerChanged: true,
      reopenedCount: 1,
      currentPointer: {
        fromVersionId: "version-2",
        toVersionId: "version-1"
      }
    });
    expect(summary.todos).toMatchObject({
      createdCount: 1,
      closedCount: 1,
      statusChangedCount: 1
    });
    expect(summary.deferred).toMatchObject({
      createdCount: 1,
      statusChangedCount: 1,
      reviewTargetChangedCount: 1
    });
    expect(summary.constraints).toMatchObject({
      createdCount: 1,
      retiredCount: 1,
      statusChangedCount: 1
    });
    expect(summary.legacyCompatibility.undos).toMatchObject({
      createdCount: 1,
      closedCount: 1,
      statusChangedCount: 1,
      reassignedCount: 1
    });
    expect(summary.pendingOperations).toMatchObject({
      proposedCount: 1,
      committedCount: 1,
      rejectedCount: 0,
      statusChangedCount: 1,
      statusCounts: {
        head: {
          committed: 1,
          pending: 1
        }
      },
      actionCounts: {
        head: {
          close_version: 1,
          set_current_version: 1
        }
      }
    });
    expect(summary.approvalArtifacts).toMatchObject({
      approvedCount: 1,
      consumedCount: 1,
      statusChangedCount: 1,
      statusCounts: {
        head: {
          approved: 1,
          consumed: 1
        }
      }
    });
    expect(summary.assets).toMatchObject({
      createdCount: 1,
      statusChangedCount: 1,
      pathChangedCount: 1
    });
    expect(summary.eventsDigest).toEqual({
      totalAdded: 3,
      byType: {
        "approval_artifact.approved": 1,
        "pending_operation.committed": 1,
        "version.reopened": 1
      }
    });
    expect(summary.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pending proposal"),
        expect.stringContaining("open todo"),
        expect.stringContaining("Deferred"),
        expect.stringContaining("Legacy compatibility"),
        expect.stringContaining("current pointer drift"),
        expect.stringContaining("self-referential Undo blocker")
      ])
    );
    expect(summary.summaryText).toContain("RouteLedger review summary: HEAD~1 -> HEAD");
    expect(summary.summaryText).toContain("Deferred:");
    expect(summary.summaryText).toContain("Constraints:");
    expect(summary.summaryText).toContain("Legacy compatibility - Undo audit records:");
    expect(summary.summaryText).toContain("Events added: 3");
    expect((summary as unknown as { events?: unknown }).events).toBeUndefined();
  });

  it("treats Deferred and Constraint-only diffs as semantic changes", () => {
    const base = createJsonCodecSnapshot();
    const head = structuredClone(base);
    const semanticRecords = createDeferredConstraintJsonSnapshot();

    head.deferredItems = structuredClone(semanticRecords.deferredItems);
    head.constraints = structuredClone(semanticRecords.constraints);

    const createdSummary = buildProjectAggregateReviewSummary(base, head);

    expect(createdSummary.overview.hasSemanticChanges).toBe(true);
    expect(createdSummary.deferred).toMatchObject({
      createdCount: 1,
      statusChangedCount: 0,
      reviewTargetChangedCount: 0
    });
    expect(createdSummary.constraints).toMatchObject({
      createdCount: 1,
      retiredCount: 0,
      statusChangedCount: 0
    });
    expect(createdSummary.summaryText).toContain("Deferred: +1 created");
    expect(createdSummary.summaryText).toContain("Constraints: +1 created");
    expect(createdSummary.summaryText).not.toContain(
      "No semantic RouteLedger changes detected"
    );

    const changedHead = structuredClone(head);
    changedHead.deferredItems[0] = {
      ...changedHead.deferredItems[0]!,
      status: "resolved",
      targetReviewVersionId: "version-1"
    };
    changedHead.constraints[0] = {
      ...changedHead.constraints[0]!,
      status: "retired",
      retiredAt: "2026-06-27T03:00:00.000Z",
      retireReason: "superseded"
    };

    const changedSummary = buildProjectAggregateReviewSummary(head, changedHead);

    expect(changedSummary.overview.hasSemanticChanges).toBe(true);
    expect(changedSummary.deferred).toMatchObject({
      statusChangedCount: 1,
      reviewTargetChangedCount: 1
    });
    expect(changedSummary.constraints).toMatchObject({
      retiredCount: 1,
      statusChangedCount: 1
    });
    expect(changedSummary.summaryText).not.toContain(
      "No semantic RouteLedger changes detected"
    );
  });

  it("treats event-only churn as non-semantic change", () => {
    const base = createJsonCodecSnapshot();
    const head = structuredClone(base);

    head.events = [
      ...head.events,
      ...Array.from({ length: 6 }, (_, index) => ({
        ...head.events[0]!,
        id: `event-extra-${index + 1}`,
        eventType: "transition.audit"
      }))
    ];

    const summary = buildProjectAggregateReviewSummary(base, head);

    expect(summary.overview.hasSemanticChanges).toBe(false);
    expect(summary.eventsDigest).toEqual({
      totalAdded: 6,
      byType: {
        "transition.audit": 6
      }
    });
    expect(summary.summaryText).toContain("No semantic RouteLedger changes detected");
  });

  it("fails fast when project ids differ", () => {
    const base = createJsonCodecSnapshot();
    const head = createJsonCodecSnapshot();

    head.project = createProjectFixture({
      id: "project-2",
      currentVersionId: "version-2",
      initialVersionId: "version-2"
    });
    head.versions = [
      createVersionFixture({
        id: "version-2",
        projectId: "project-2",
        state: "running",
        isCurrent: true
      })
    ];
    head.todos = [];
    head.undos = [];
    head.assets = [];
    head.events = [];
    head.pendingOperations = [];
    head.approvalArtifacts = [];

    expect(() => buildProjectAggregateReviewSummary(base, head)).toThrowError(
      RouteLedgerJsonReviewSummaryError
    );
    expect(() => buildProjectAggregateReviewSummary(base, head)).toThrowError(
      /projectId 不一致/
    );
  });
});
