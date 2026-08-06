import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Actor, ProjectAggregateSnapshot } from "@routeledger/core";

import {
  AuditDrawer,
  OverviewStats,
  renderCurrentVersionPanel
} from "../App.js";
import { buildMissionControlViewModel } from "../server/mission-control-vm.js";
import type {
  MissionControlBindingSummary,
  MissionControlStorageSummary
} from "../shared/mission-control.js";

const timestamp = "2026-07-25T08:00:00.000Z";
const actor: Actor = {
  id: "agent-1",
  type: "agent",
  displayName: "Test Agent"
};

const binding: MissionControlBindingSummary = {
  status: "bound",
  workspaceRoot: "/workspace",
  workspaceRootSource: "explicit_arg",
  workspaceRootConfidence: "high",
  workspaceConfigPath: "/workspace/.routeledger/config.json",
  routeledgerRoot: "/workspace/project",
  dataRoot: "/workspace/project",
  routeledgerDir: "/workspace/project/.routeledger",
  diagnostics: []
};

const storage: MissionControlStorageSummary = {
  mode: "json",
  canonicalJson: {
    status: "ready",
    projectPath: "/workspace/project/.routeledger/project.json",
    issues: []
  },
  sqlite: {
    status: "absent",
    dbPath: "/workspace/project/.routeledger/db/routeledger.sqlite3",
    error: null
  }
};

const createSnapshot = (includeLegacyUndo = true): ProjectAggregateSnapshot => ({
  project: {
    id: "project-1",
    name: "Mission Control",
    description: "UI semantics fixture",
    status: "active",
    currentVersionId: "version-1",
    initialVersionId: "version-1",
    createdBy: actor,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settings: {
      enforceStartGate: true,
      enforceCloseGate: true,
      contextBudgetBytes: 32768
    }
  },
  versions: [
    {
      id: "version-1",
      projectId: "project-1",
      title: "Current",
      description: "Current version",
      state: "complete",
      parentVersionId: null,
      previousVersionId: null,
      nextVersionId: "version-2",
      order: 1,
      isCurrent: true,
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      stateReason: null
    },
    {
      id: "version-2",
      projectId: "project-1",
      title: "Review",
      description: "Deferred review version",
      state: "ready",
      parentVersionId: null,
      previousVersionId: "version-1",
      nextVersionId: null,
      order: 2,
      isCurrent: false,
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      stateReason: null
    }
  ],
  workItems: [
    {
      id: "work-todo",
      projectId: "project-1",
      title: "Ship Todo",
      type: "other",
      status: "active",
      originVersionId: "version-1",
      activeRecordType: "todo",
      activeRecordId: "todo-1",
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      summary: "Ship Todo"
    },
    {
      id: "work-deferred",
      projectId: "project-1",
      title: "Review later",
      type: "other",
      status: "active",
      originVersionId: "version-1",
      activeRecordType: "deferred",
      activeRecordId: "deferred-1",
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      summary: "Review later"
    },
    ...(includeLegacyUndo
      ? [
          {
            id: "work-legacy",
            projectId: "project-1",
            title: "Legacy blocker",
            type: "other" as const,
            status: "active" as const,
            originVersionId: "version-1",
            activeRecordType: "undo" as const,
            activeRecordId: "undo-1",
            createdBy: actor,
            createdAt: timestamp,
            updatedAt: timestamp,
            closedAt: null,
            summary: "Legacy blocker"
          }
        ]
      : [])
  ],
  todos: [
    {
      id: "todo-1",
      projectId: "project-1",
      workItemId: "work-todo",
      versionId: "version-1",
      title: "Ship Todo",
      description: "Finish the current delivery",
      status: "running",
      sourceType: "manual",
      sourceId: null,
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      closeReason: null,
      closeNote: null
    }
  ],
  undos: includeLegacyUndo
    ? [
        {
          id: "undo-1",
          projectId: "project-1",
          workItemId: "work-legacy",
          versionId: "version-1",
          originVersionId: "version-1",
          preferredResolutionVersionId: "version-2",
          sourceType: "manual",
          sourceId: null,
          title: "Legacy blocker",
          description: "Historical compatibility record",
          status: "wait",
          reason: "Requires legacy audit",
          triggerCondition: null,
          createdBy: actor,
          createdAt: timestamp,
          updatedAt: timestamp,
          carriedForwardAt: null,
          carriedForwardToVersionId: null,
          closedAt: null,
          closeReason: null,
          closeNote: null
        }
      ]
    : [],
  deferredItems: [
    {
      id: "deferred-1",
      projectId: "project-1",
      workItemId: "work-deferred",
      originVersionId: "version-1",
      targetReviewVersionId: "version-2",
      title: "Review later",
      description: "Review when Version 2 starts",
      status: "pending",
      reason: "Needs Version 2 context",
      reviewTrigger: "Version 2 starts",
      resolutionOutcome: null,
      resolutionReason: null,
      resolutionNote: null,
      decisionRef: null,
      activatedTodoId: null,
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewedAt: null
    }
  ],
  constraints: [
    {
      id: "constraint-project",
      projectId: "project-1",
      rule: "Keep Agent semantics simple",
      rationale: "Avoid hidden lifecycle concepts",
      scope: {
        type: "project"
      },
      status: "active",
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      retiredAt: null,
      retireReason: null,
      retireNote: null
    },
    {
      id: "constraint-version",
      projectId: "project-1",
      rule: "Do not migrate live data",
      rationale: "Migration is a later explicit operation",
      scope: {
        type: "version",
        versionId: "version-1"
      },
      status: "active",
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      retiredAt: null,
      retireReason: null,
      retireNote: null
    }
  ],
  assets: [],
  events: [],
  pendingOperations: [],
  approvalArtifacts: []
});

const buildViewModel = (includeLegacyUndo = true) =>
  buildMissionControlViewModel(
    createSnapshot(includeLegacyUndo),
    binding,
    storage,
    "ready",
    "read only"
  );

describe("Mission Control deferred semantics", () => {
  it("builds Todo, Deferred and Constraint statistics without legacy records contaminating them", async () => {
    const response = await buildViewModel(true);

    expect(response.overview).toMatchObject({
      openTodoCount: 1,
      pendingDeferredCount: 1,
      dueDeferredCount: 1,
      activeConstraintCount: 2
    });
    expect(response.overview).not.toHaveProperty("openUndoCount");
    expect(response.roadmap[0]).toMatchObject({
      openTodoCount: 1,
      pendingDeferredCount: 0,
      activeConstraintCount: 1
    });
    expect(response.roadmap[0]).not.toHaveProperty("openUndoCount");
    expect(response.roadmap[1]).toMatchObject({
      pendingDeferredCount: 1,
      activeConstraintCount: 0
    });
    expect(response.currentVersion?.deferred).toEqual([
      expect.objectContaining({
        id: "deferred-1",
        targetReviewVersionTitle: "Review",
        isDue: true
      })
    ]);
    expect(response.currentVersion?.constraints).toHaveLength(2);
    expect(response.currentVersion).not.toHaveProperty("undos");
    expect(response.legacyAudit).toMatchObject({
      openRecordCount: 1,
      currentVersionBlockerCount: 1
    });
    expect(response.statusRisks.length).toBeGreaterThan(0);
    expect(
      response.statusRisks.some((risk) => risk.summary.includes("历史工作"))
    ).toBe(true);

    const contract = JSON.stringify(response);
    expect(contract).not.toContain("workItemId");
    expect(contract).not.toContain("originVersionId");
  });

  it("keeps the no-legacy state explicit and leaves Deferred and Constraint counts unchanged", async () => {
    const response = await buildViewModel(false);

    expect(response.overview).toMatchObject({
      pendingDeferredCount: 1,
      dueDeferredCount: 1,
      activeConstraintCount: 2
    });
    expect(response.legacyAudit).toEqual({
      openRecordCount: 0,
      currentVersionBlockerCount: 0,
      records: []
    });
  });

  it("renders the default panels without Undo and confines it to the legacy audit drawer", async () => {
    const response = await buildViewModel(true);
    const defaultMarkup = [
      renderToStaticMarkup(OverviewStats({ overview: response.overview! })),
      renderToStaticMarkup(renderCurrentVersionPanel(response.currentVersion))
    ].join("");
    const auditMarkup = renderToStaticMarkup(
      AuditDrawer({
        approvals: [],
        events: [],
        legacyAudit: response.legacyAudit
      })
    );

    expect(defaultMarkup).toContain("Pending Deferred");
    expect(defaultMarkup).toContain("Active Constraints");
    expect(defaultMarkup).toContain("DUE");
    expect(defaultMarkup).not.toContain("Undo");
    expect(auditMarkup).toContain("Legacy Undo Audit");
    expect(auditMarkup).toContain("Legacy blocker");
  });

  it("renders clear empty states for Deferred and Constraint", async () => {
    const response = await buildViewModel(false);
    const emptyMarkup = renderToStaticMarkup(
      renderCurrentVersionPanel({
        ...response.currentVersion!,
        deferred: [],
        constraints: []
      })
    );

    expect(emptyMarkup).toContain("暂无相关 Deferred");
    expect(emptyMarkup).toContain("暂无 Active Constraint");
    expect(emptyMarkup).not.toContain("Undo");
  });
});
