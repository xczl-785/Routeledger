import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Actor, ProjectAggregateSnapshot } from "@routeledger/core";

import { CurrentVersionColumn, RouteRail, VersionHorizon } from "../App.js";
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
      contextBudgetBytes: 32768,
      contentLocale: "en"
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
    expect(response.versionDetails).toHaveLength(2);
    expect(response.versionDetails[1]).toMatchObject({
      id: "version-2",
      title: "Review",
      state: "ready"
    });
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

  it("renders Version Horizon with current work semantics and confines legacy records to history", async () => {
    const response = await buildViewModel(true);
    const currentMarkup = renderToStaticMarkup(
      <CurrentVersionColumn response={response} />
    );
    const pageMarkup = renderToStaticMarkup(
      <VersionHorizon response={response} refreshing={false} onRefresh={() => undefined} />
    );

    expect(currentMarkup).toContain("当前工作概览");
    expect(currentMarkup).toContain("Deferred");
    expect(currentMarkup).toContain("Constraints（2）");
    expect(currentMarkup).toContain("本 Version 需复评");
    expect(currentMarkup).not.toContain("Undo");
    expect(pageMarkup).toContain("历史兼容审计");
    expect(pageMarkup).toContain("Legacy blocker");
    expect(pageMarkup).toContain("版本航迹");
    expect(pageMarkup).toContain('aria-current="step"');
    expect(pageMarkup).not.toContain("Mission Control V2");
  });

  it("renders clear empty states for Deferred and Constraint in the rebuilt current column", async () => {
    const response = await buildViewModel(false);
    const emptyCurrent = {
      ...response.currentVersion!,
      deferred: [],
      constraints: []
    };
    const emptyMarkup = renderToStaticMarkup(
      <CurrentVersionColumn
        response={{
          ...response,
          currentVersion: emptyCurrent,
          versionDetails: response.versionDetails.map((version) =>
            version.id === emptyCurrent.id ? emptyCurrent : version
          )
        }}
      />
    );

    expect(emptyMarkup).toContain("该 Version 没有当前相关的 Deferred");
    expect(emptyMarkup).toContain("Constraints（0）");
    expect(emptyMarkup).not.toContain("Undo");
  });

  it("counts the complete downstream route while keeping later Versions collapsed", async () => {
    const response = await buildViewModel(false);
    const first = response.roadmap[0]!;
    const template = response.roadmap[1]!;
    const downstream = Array.from({ length: 14 }, (_, index) => {
      const order = index + 2;
      return {
        ...template,
        id: `version-${order}`,
        title: `Version ${order}`,
        order,
        previousVersionId: order === 2 ? first.id : `version-${order - 1}`,
        nextVersionId: order === 15 ? null : `version-${order + 1}`
      };
    });
    const pageMarkup = renderToStaticMarkup(
      <VersionHorizon
        response={{
          ...response,
          roadmap: [{ ...first, nextVersionId: "version-2" }, ...downstream]
        }}
        refreshing={false}
        onRefresh={() => undefined}
      />
    );

    expect(pageMarkup).toContain("后续 13 个 Version");
    expect(pageMarkup).toContain("还有 10 个版本");
    expect(pageMarkup).toContain('data-route-node="version-15"');
    expect(pageMarkup.match(/Version 15/g)).toHaveLength(1);
  });

  it("renders past, current and future nodes in one complete route rail", async () => {
    const response = await buildViewModel(false);
    const previous = { ...response.roadmap[0]!, isCurrent: false, nextVersionId: "version-current" };
    const current = {
      ...response.roadmap[0]!,
      id: "version-current",
      title: "Current anchor",
      order: 4,
      isCurrent: true,
      previousVersionId: previous.id,
      nextVersionId: "version-future"
    };
    const child = {
      ...response.roadmap[1]!,
      id: "version-child",
      title: "Child route checkpoint",
      order: 2,
      isCurrent: false,
      parentVersionId: previous.id,
      previousVersionId: null,
      nextVersionId: null
    };
    const grandchild = {
      ...response.roadmap[1]!,
      id: "version-grandchild",
      title: "Nested child checkpoint",
      order: 3,
      isCurrent: false,
      parentVersionId: child.id,
      previousVersionId: null,
      nextVersionId: null
    };
    const future = {
      ...response.roadmap[1]!,
      id: "version-future",
      title: "Future destination",
      order: 5,
      isCurrent: false,
      previousVersionId: current.id,
      nextVersionId: null
    };
    const railMarkup = renderToStaticMarkup(
      <RouteRail roadmap={[previous, child, grandchild, current, future]} current={current} />
    );

    expect(railMarkup).toContain("过去 · 1");
    expect(railMarkup).toContain("过去 · 子路线 L1 · 2");
    expect(railMarkup).toContain("过去 · 子路线 L2 · 3");
    expect(railMarkup).toContain('data-route-depth="2"');
    expect(railMarkup).toContain("当前 · 4");
    expect(railMarkup).toContain("未来 · 5");
    expect(railMarkup).toContain("过去向上 · 未来向下");
    expect(railMarkup).toContain('aria-current="step"');
    expect(railMarkup).toContain("route-state tone-ready");
  });

  it("renders a selected future Version without changing the canonical current marker", async () => {
    const response = await buildViewModel(false);
    const selectedMarkup = renderToStaticMarkup(
      <CurrentVersionColumn
        response={response}
        viewedVersionId="version-2"
        onReturnToCurrent={() => undefined}
      />
    );

    expect(selectedMarkup).toContain("查看未来版本");
    expect(selectedMarkup).toContain("Review");
    expect(selectedMarkup).toContain("查看当前 Version");
    expect(selectedMarkup).toContain("该 Version 的当前留存记录");
  });

  it("keeps the closed history dialog inert and exposes its dialog relationship", async () => {
    const response = await buildViewModel(false);
    const pageMarkup = renderToStaticMarkup(
      <VersionHorizon response={response} refreshing={false} onRefresh={() => undefined} />
    );

    expect(pageMarkup).toContain('aria-controls="history-drawer"');
    expect(pageMarkup).toContain('id="history-drawer"');
    expect(pageMarkup).toContain('role="dialog"');
    expect(pageMarkup).toContain('aria-modal="true"');
    expect(pageMarkup).toContain("inert");
  });
});
