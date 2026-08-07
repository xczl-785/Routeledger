import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, describe } from "vitest";

import { TEST_ACTOR, createTestDependencies, createProjectFixture, createVersionFixture } from "./builders.js";
import { RouteLedgerService } from "../index.js";

import { MemoryStorageAdapter, createTempProjectRoot, cleanupProjectRoot, createPreparedProject, createApprovedArtifact, startPreparedVersion, closeVersionThroughL3, completeCurrentVersion, createCommittedVersion, createUnresolvedDeferredForCloseout, setCurrentVersionForTest } from "./routeledger-service-test-helpers.js";
describe("route ledger service", () => {
  it("getCurrentContext returns a default version window and can include all versions", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const versions = Array.from({ length: 8 }, (_, index) =>
      createVersionFixture({
        id: `version-${index + 1}`,
        title: index === 5 ? "_probe top-level B" : `V${index + 1}`,
        state: index === 3 ? "running" : "wait",
        isCurrent: index === 3,
        order: index + 1,
        previousVersionId: index === 0 ? null : `version-${index}`,
        nextVersionId: index === 7 ? null : `version-${index + 2}`
      })
    );

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: "version-4"
      }),
      versions,
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });

    const defaultContext = await service.getCurrentContext({
      projectId: "project-1"
    });
    const fullContext = await service.getCurrentContext({
      projectId: "project-1",
      includeAllVersions: true
    });
    const listWindow = await service.listVersionsWindow({
      projectId: "project-1"
    });

    expect((defaultContext.data as { versions: Array<{ id: string }> }).versions.map((version) => version.id)).toEqual([
      "version-1",
      "version-2",
      "version-3",
      "version-4",
      "version-5",
      "version-6",
      "version-7"
    ]);
    expect(
      (
        defaultContext.meta as {
          versionWindow: {
            aroundVersionId: string | null;
            before: number;
            after: number;
            includeAllVersions: boolean;
            totalCount: number;
            includedCount: number;
            omittedBeforeCount: number;
            omittedAfterCount: number;
          };
        }
      ).versionWindow
    ).toMatchObject({
      aroundVersionId: "version-4",
      before: 3,
      after: 3,
      includeAllVersions: false,
      totalCount: 8,
      includedCount: 7,
      omittedBeforeCount: 0,
      omittedAfterCount: 1
    });
    expect((fullContext.data as { versions: Array<{ id: string }> }).versions).toHaveLength(8);
    expect(
      (
        fullContext.meta as {
          versionWindow: {
            includeAllVersions: boolean;
            totalCount: number;
            includedCount: number;
            omittedBeforeCount: number;
            omittedAfterCount: number;
          };
        }
      ).versionWindow
    ).toMatchObject({
      includeAllVersions: true,
      totalCount: 8,
      includedCount: 8,
      omittedBeforeCount: 0,
      omittedAfterCount: 0
    });
    expect(listWindow).toMatchObject({
      data: {
        aroundVersionId: "version-4"
      },
      meta: {
        versionWindow: {
          aroundVersionId: "version-4",
          totalCount: 8,
          includedCount: 7
        }
      }
    });
  });

  it("listVersionsWindow 鍦ㄥ熬閮?anchor 涓婅繑鍥炴纭殑 head-tail 杈圭晫缁熻", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const versions = Array.from({ length: 8 }, (_, index) =>
      createVersionFixture({
        id: `version-${index + 1}`,
        title: `V${index + 1}`,
        state: index === 3 ? "running" : "wait",
        isCurrent: index === 3,
        order: index + 1,
        previousVersionId: index === 0 ? null : `version-${index}`,
        nextVersionId: index === 7 ? null : `version-${index + 2}`
      })
    );

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: "version-4"
      }),
      versions,
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });

    const window = await service.listVersionsWindow({
      projectId: "project-1",
      aroundVersionId: "version-8",
      before: 2,
      after: 3
    });

    expect((window.data as { aroundVersionId: string | null }).aroundVersionId).toBe("version-8");
    expect((window.data as { versions: Array<{ id: string }> }).versions.map((version) => version.id)).toEqual([
      "version-6",
      "version-7",
      "version-8"
    ]);
    expect(
      (
        window.meta as {
          versionWindow: {
            aroundVersionId: string | null;
            before: number;
            after: number;
            totalCount: number;
            includedCount: number;
            omittedBeforeCount: number;
            omittedAfterCount: number;
          };
        }
      ).versionWindow
    ).toMatchObject({
      aroundVersionId: "version-8",
      before: 2,
      after: 3,
      totalCount: 8,
      includedCount: 3,
      omittedBeforeCount: 5,
      omittedAfterCount: 0
    });
  });

  it("listVersionsWindow 鍦?aroundVersionId 鏃犳晥鏃舵姏鍑?VERSION_NOT_FOUND", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({
        id: "project-1",
        currentVersionId: "version-1"
      }),
      versions: [
        createVersionFixture({
          id: "version-1",
          title: "V1",
          state: "running",
          isCurrent: true,
          order: 1
        })
      ],
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });

    await expect(
      service.listVersionsWindow({
        projectId: "project-1",
        aroundVersionId: "version-missing",
        before: 1,
        after: 1
      })
    ).rejects.toMatchObject({
      code: "VERSION_NOT_FOUND",
      details: {
        aroundVersionId: "version-missing"
      }
    });
  });

  it("checkDocDrift flags stale current-version text, missing pointers, and missing files", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });
      const nextVersionId = await createCommittedVersion(
        service,
        created.project.id,
        "Version Closeout Plan",
        "new current version"
      );

      await service.prepareVersion({
        projectId: created.project.id,
        versionId: nextVersionId,
        actor: TEST_ACTOR
      });
      await setCurrentVersionForTest(service, created.project.id, nextVersionId);

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        [
          "# RouteLedger",
          "",
          "Current version is still Initial Version.",
          "The mainline description has not been updated yet."
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "AGENTS.md"),
        [
          "# Agent Entry",
          "",
          "QA entry still points to `docs/qa/legacy-checklist.md`."
        ].join("\n"),
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md", "AGENTS.md", "docs/missing.md"],
        expectedPointers: [
          {
            kind: "qa",
            path: "docs/qa/current-checklist.md"
          }
        ]
      });

      expect(result.data.routeTruth.currentVersion).toMatchObject({
        id: nextVersionId,
        title: "Version Closeout Plan"
      });
      expect(result.data.routeTruth).toMatchObject({
        openTodoCount: 0,
        openUndoCount: 0,
        pendingProposalCount: 0,
        statusRiskCodes: []
      });
      expect(result.data.checkedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "README.md",
            matchedWarningCount: 1
          }),
          expect.objectContaining({
            path: "AGENTS.md",
            matchedWarningCount: 0
          })
        ])
      );
      expect(result.data.unreadableFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "docs/missing.md",
            code: "ENOENT"
          })
        ])
      );
      expect(result.data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "STALE_CURRENT_VERSION",
            file: "README.md"
          }),
          expect.objectContaining({
            code: "MISSING_EXPECTED_POINTER",
            file: null,
            expected: "docs/qa/current-checklist.md"
          })
        ])
      );
      expect(result.data.suggestedTodos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: expect.stringContaining("README.md"),
            file: "README.md",
            reason: expect.stringContaining("current")
          }),
          expect.objectContaining({
            title: expect.stringContaining("docs/qa/current-checklist.md"),
            file: null,
            reason: expect.stringContaining("docs/qa/current-checklist.md")
          })
        ])
      );
      expect(result.data.summaryText).toContain("Checked 2 entry files for project RouteLedger.");
      expect(result.data.summaryText).toContain(
        `Current version: Version Closeout Plan (${nextVersionId}).`
      );
      expect(result.data.summaryText).toContain(
        "Found 2 warnings and 1 unreadable files."
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift 鍦ㄧ己灏?projectRoot 鏃朵粛鐩存帴鎶ラ敊", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      name: "RouteLedger",
      actor: TEST_ACTOR
    });

    await expect(
      service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      })
    ).rejects.toThrow("checkDocDrift requires RouteLedgerServiceOptions.projectRoot");
  });

  it("checkDocDrift 鍦?SQLite 琚啓鎴愬敮涓€鐪熸簮鏃惰繑鍥?STALE_TRUTH_SOURCE", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        "SQLite is the source of truth for the runtime route state.",
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(result.data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "STALE_TRUTH_SOURCE",
            file: "README.md"
          })
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift 鍦?entry docs 宸插悓姝ユ椂涓嶈繑鍥?warning", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });

      fs.mkdirSync(path.join(projectRoot, "docs", "capabilities"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        [
          "# RouteLedger",
          "",
          `褰撳墠鐗堟湰: Initial Version (${created.initialVersion.id})`,
          "Runtime truth lives in `.routeledger/` canonical JSON.",
          "Capability entrypoint: `docs/capabilities/cap-mcp-route-operations.md`."
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "docs/capabilities/cap-mcp-route-operations.md"),
        "currentVersion -> Initial Version\n",
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md", "docs/capabilities/cap-mcp-route-operations.md"],
        expectedPointers: [
          {
            kind: "capability",
            path: "docs/capabilities/cap-mcp-route-operations.md"
          }
        ]
      });

      expect(result.data.warnings).toEqual([]);
      expect(result.data.unreadableFiles).toEqual([]);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift 鎶?canonical current pointer 鏂囨。瑙嗕负宸插悓姝ワ紝浣嗘棫 current 鏂囨湰浠嶄細鎶?drift", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });
      const nextVersionId = await createCommittedVersion(
        service,
        created.project.id,
        "Version Closeout Plan",
        "new current version"
      );

      await service.prepareVersion({
        projectId: created.project.id,
        versionId: nextVersionId,
        actor: TEST_ACTOR
      });
      await setCurrentVersionForTest(service, created.project.id, nextVersionId);

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        [
          "# RouteLedger",
          "",
          "Current version: see `.routeledger/refs/current.json`."
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "AGENTS.md"),
        [
          "# Agent Entry",
          "",
          "Current version is still Initial Version."
        ].join("\n"),
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md", "AGENTS.md"]
      });

      expect(result.data.warnings).toEqual([
        expect.objectContaining({
          code: "STALE_CURRENT_VERSION",
          file: "AGENTS.md"
        })
      ]);
      expect(result.data.unreadableFiles).toEqual([]);
      expect(result.data.checkedFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "README.md",
            matchedWarningCount: 0
          }),
          expect.objectContaining({
            path: "AGENTS.md",
            matchedWarningCount: 1
          })
        ])
      );
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift accepts Windows-style canonical current pointers as synchronized", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });
      const nextVersionId = await createCommittedVersion(
        service,
        created.project.id,
        "Version Closeout Plan",
        "new current version"
      );

      await service.prepareVersion({
        projectId: created.project.id,
        versionId: nextVersionId,
        actor: TEST_ACTOR
      });
      await setCurrentVersionForTest(service, created.project.id, nextVersionId);

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        [
          "# RouteLedger",
          "",
          "Current version: see `.routeledger\\refs\\current.json`."
        ].join("\n"),
        "utf8"
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(result.data.warnings).toEqual([]);
      expect(result.data.unreadableFiles).toEqual([]);
      expect(result.data.checkedFiles).toEqual([
        expect.objectContaining({
          path: "README.md",
          matchedWarningCount: 0
        })
      ]);
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift 浼氭嫆缁濊秺鐣?entry file path", async () => {
    const projectRoot = createTempProjectRoot();
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });

      await expect(
        service.checkDocDrift({
          projectId: created.project.id,
          entryFiles: ["../README.md"]
        })
      ).rejects.toMatchObject({
        code: "INVALID_ASSET_PATH",
        details: {
          field: "entryFiles[0]",
          path: "../README.md"
        }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("checkDocDrift does not follow symlinks outside the project root", async () => {
    const projectRoot = createTempProjectRoot();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-core-outside-"));
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      projectRoot,
      deps: createTestDependencies()
    });

    try {
      const created = await service.initProject({
        name: "RouteLedger",
        actor: TEST_ACTOR
      });

      const outsideFilePath = path.join(outsideRoot, "outside-entry.md");
      fs.writeFileSync(outsideFilePath, "褰撳墠鐗堟湰浠嶆槸 leaked version銆俓n", "utf8");
      fs.symlinkSync(outsideFilePath, path.join(projectRoot, "README.md"));

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(result.data.checkedFiles).toEqual([]);
      expect(result.data.warnings).toEqual([]);
      expect(result.data.unreadableFiles).toEqual([
        expect.objectContaining({
          path: "README.md",
          code: "ENTRY_FILE_OUTSIDE_PROJECT_ROOT"
        })
      ]);
    } finally {
      cleanupProjectRoot(projectRoot);
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("carry_forward_undo clears the source close gate but still blocks target start as a due undo", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const downstreamVersionId = await createCommittedVersion(
      service,
      prepared.projectId,
      "Downstream",
      "downstream target"
    );
    await service.prepareVersion({
      projectId: prepared.projectId,
      versionId: downstreamVersionId,
      actor: TEST_ACTOR
    });
    const createdUndo = await service.createUndo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      originVersionId: prepared.versionId,
      preferredResolutionVersionId: prepared.versionId,
      title: "carry me",
      reason: "defer downstream",
      actor: TEST_ACTOR
    });

    await service.carryForwardUndo({
      projectId: prepared.projectId,
      undoId: createdUndo.undo.id,
      preferredResolutionVersionId: downstreamVersionId,
      reason: "route to downstream version",
      note: "keep as downstream undo",
      actor: TEST_ACTOR
    });

    const closeGate = await service.checkCloseGate({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      residualAudit: [
        {
          kind: "debt",
          summary: "none",
          destination: "close"
        }
      ],
      actor: TEST_ACTOR
    });
    const startGate = await service.checkStartGate({
      projectId: prepared.projectId,
      versionId: downstreamVersionId,
      actor: TEST_ACTOR
    });

    expect(closeGate.allowed).toBe(true);
    expect(closeGate.unresolvedUndoIds).toEqual([]);
    expect(startGate.allowed).toBe(false);
    expect(startGate.dueUndoIds).toEqual([createdUndo.undo.id]);

    await closeVersionThroughL3(
      service,
      prepared.projectId,
      prepared.versionId
    );
    const defaultContext = await service.getCurrentContext({
      projectId: prepared.projectId
    });
    const auditContext = await service.getCurrentContext({
      projectId: prepared.projectId,
      includeLegacyUndo: true
    });
    const nextAction = await service.getNextAction({
      projectId: prepared.projectId
    });
    const defaultData = defaultContext.data as Record<string, any>;
    const auditData = auditContext.data as Record<string, any>;
    const nextActionData = nextAction.data as Record<string, any>;

    expect(defaultData).not.toHaveProperty("openUndos");
    expect(defaultData).not.toHaveProperty("legacyUndo");
    expect(defaultData.gates.start).toMatchObject({
      allowed: false,
      blockers: [
        expect.objectContaining({
          code: "LEGACY_WORK_REQUIRES_AUDIT",
          recordIds: [createdUndo.undo.id]
        })
      ]
    });
    expect(defaultData.statusRisks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "START_GATE_BLOCKED",
          severity: "blocking",
          recordIds: [createdUndo.undo.id]
        })
      ])
    );
    expect(defaultData.nextAction).toMatchObject({
      actionType: "review_context",
      targetId: downstreamVersionId,
      blockingRiskCodes: ["START_GATE_BLOCKED"]
    });
    expect(auditData.legacyUndo).toEqual([
      expect.objectContaining({
        id: createdUndo.undo.id
      })
    ]);
    expect(auditData.nextAction).toEqual(defaultData.nextAction);
    expect(nextActionData.nextAction).toEqual(defaultData.nextAction);
    expect(JSON.stringify(nextActionData.gates.start)).not.toContain(
      "OPEN_DUE_UNDOS"
    );
  });

  it("propagates unresolved Deferred IDs through version closeout summary and plan", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const deferredId = await createUnresolvedDeferredForCloseout(
      service,
      storage,
      prepared.projectId,
      prepared.versionId
    );

    const summary = await service.summarizeVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });

    expect(summary.data).toMatchObject({
      canClose: false,
      closeGate: {
        ok: false,
        unresolvedDeferredIds: [deferredId],
        blockedConstraintIds: []
      }
    });
    expect(summary.data.closeGate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DEFERRED_ROUTE_TARGET_SELF",
          recordIds: [deferredId]
        })
      ])
    );
    expect(plan.data).toMatchObject({
      status: "blocked",
      summary: {
        canClose: false,
        closeGate: {
          ok: false,
          unresolvedDeferredIds: [deferredId],
          blockedConstraintIds: []
        }
      }
    });
  });

  it("propagates unresolved Deferred IDs through shutdown ordinaryCloseGate", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);
    const deferredId = await createUnresolvedDeferredForCloseout(
      service,
      storage,
      prepared.projectId,
      prepared.versionId
    );

    const workflow = await service.shutdownVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      shutdownReason: "route_integrity_failure",
      mode: "dry_run",
      actor: TEST_ACTOR
    });

    expect(workflow).toMatchObject({
      status: "ready",
      forced: true,
      ordinaryCloseGate: {
        allowed: false,
        unresolvedDeferredIds: [deferredId],
        blockedConstraintIds: []
      }
    });
    expect(workflow.ordinaryCloseGate.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DEFERRED_ROUTE_TARGET_SELF",
          recordIds: [deferredId]
        })
      ])
    );
  });

  it("shutdown_version ordinaryCloseGate keeps missing residual audit visible", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await completeCurrentVersion(service, storage);

    const workflow = await service.shutdownVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      shutdownReason: "emergency_stop",
      mode: "dry_run",
      actor: TEST_ACTOR
    });

    expect(workflow.status).toBe("ready");
    expect(workflow.ordinaryCloseGate).toMatchObject({
      allowed: false,
      unresolvedTodoIds: [],
      unresolvedUndoIds: []
    });
    expect(workflow.ordinaryCloseGate.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })])
    );
  });

  it("shutdown_version creates a forced L3 path and commits as SHUTDOWN close", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const prepared = await createPreparedProject(service, storage);
    await startPreparedVersion(service, prepared.projectId, prepared.versionId);
    await service.createTodo({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      title: "still open",
      actor: TEST_ACTOR
    });

    const workflow = await service.shutdownVersionWorkflow({
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      shutdownReason: "emergency_stop",
      reason: "force close after severe runtime failure",
      mode: "propose",
      actor: TEST_ACTOR
    });

    expect(workflow).toMatchObject({
      status: "ready",
      forced: true,
      shutdownStateReason: "shutdown:emergency_stop"
    });
    expect(workflow.ordinaryCloseGate.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TARGET_VERSION_NOT_COMPLETE" })])
    );

    const artifact = await createApprovedArtifact(
      service,
      prepared.projectId,
      workflow.pendingOperationId!
    );
    const committed = await service.commitL3Operation({
      projectId: prepared.projectId,
      pendingOperationId: workflow.pendingOperationId!,
      approvalArtifactId: artifact.id,
      actor: TEST_ACTOR
    });
    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    const version = snapshot?.versions.find((item) => item.id === prepared.versionId);
    const shutdownEvent = snapshot?.events.find(
      (event) =>
        event.targetType === "version" &&
        event.targetId === prepared.versionId &&
        event.eventType === "version.shutdown"
    );

    expect(committed.pendingOperation.actionType).toBe("shutdown_version");
    expect(version).toMatchObject({
      state: "close",
      stateReason: "shutdown:emergency_stop"
    });
    expect(shutdownEvent?.metadata).toMatchObject({
      forced: true,
      shutdownReason: "emergency_stop",
      stateReason: "shutdown:emergency_stop"
    });

    const plan = await service.planVersionCloseout({
      projectId: prepared.projectId,
      versionId: prepared.versionId
    });
    expect(plan.data.version).toMatchObject({
      displayState: "shutdown",
      isShutdown: true,
      stateReason: "shutdown:emergency_stop"
    });
    expect(plan.data.steps[0]).toMatchObject({
      kind: "no_op"
    });
  });


});
