import { expect, it, describe } from "vitest";

import { TEST_ACTOR, createTestDependencies, createProjectFixture, createTodoFixture, createUndoFixture, createVersionFixture } from "./builders.js";
import { RouteLedgerService } from "../index.js";

import { MemoryDocumentSource, MemoryStorageAdapter, createPreparedProject, createApprovedArtifact, startPreparedVersion, closeVersionThroughL3, completeCurrentVersion, createCommittedVersion, createUnresolvedDeferredForCloseout, setCurrentVersionForTest } from "./routeledger-service-test-helpers.js";
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

  it("orders context todos by version order, creation time, and ID", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });
    const versions = [
      createVersionFixture({ id: "version-1", order: 1, isCurrent: true }),
      createVersionFixture({ id: "version-2", order: 2 })
    ];

    await storage.saveProjectAggregate({
      project: createProjectFixture({ currentVersionId: "version-1" }),
      versions,
      workItems: [],
      todos: [
        createTodoFixture({
          id: "todo-version-2",
          versionId: "version-2",
          createdAt: "2026-06-26T00:00:00.000Z"
        }),
        createTodoFixture({
          id: "todo-b",
          versionId: "version-1",
          createdAt: "2026-06-27T00:00:00.000Z"
        }),
        createTodoFixture({
          id: "todo-a",
          versionId: "version-1",
          createdAt: "2026-06-27T00:00:00.000Z"
        }),
        createTodoFixture({
          id: "todo-earlier",
          versionId: "version-1",
          createdAt: "2026-06-26T00:00:00.000Z"
        })
      ],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });

    const context = await service.getCurrentContext({ projectId: "project-1" });

    expect(
      (context.data as { todos: Array<{ id: string }> }).todos.map((todo) => todo.id)
    ).toEqual(["todo-earlier", "todo-a", "todo-b", "todo-version-2"]);
  });

  it("checkStartGate reports open todos for the requested target version", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });

    await storage.saveProjectAggregate({
      project: createProjectFixture({ currentVersionId: "version-1" }),
      versions: [
        createVersionFixture({ id: "version-1", state: "close", order: 1, isCurrent: true }),
        createVersionFixture({ id: "version-2", state: "ready", order: 2 })
      ],
      workItems: [],
      todos: [
        createTodoFixture({ id: "current-todo", versionId: "version-1" }),
        createTodoFixture({ id: "target-todo", versionId: "version-2" })
      ],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: []
    });

    const gate = await service.checkStartGate({
      projectId: "project-1",
      versionId: "version-2",
      actor: TEST_ACTOR
    });

    expect(gate.allowed).toBe(true);
    expect(gate.openTodoIds).toEqual(["target-todo"]);
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
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
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

      documentSource.setDocument(
        "README.md",
        [
          "# RouteLedger",
          "",
          "Current version is still Initial Version.",
          "The mainline description has not been updated yet."
        ].join("\n"),
      );
      documentSource.setDocument(
        "AGENTS.md",
        [
          "# Agent Entry",
          "",
          "QA entry still points to `docs/qa/legacy-checklist.md`."
        ].join("\n"),
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

      expect(result.data.status).toBe("partial");
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
      expect(result.data.checkedAssertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "current_version_title",
            file: "README.md",
            status: "mismatched",
            actual: "still Initial Version."
          }),
          expect.objectContaining({
            kind: "current_version_id",
            file: "README.md",
            status: "not_detected"
          }),
          expect.objectContaining({
            kind: "current_version_state",
            file: "AGENTS.md",
            status: "not_detected"
          })
        ])
      );
      expect(result.data.coverage).toMatchObject({
        level: "partial",
        checkedFileCount: 2,
        recognizedAssertionCount: 1,
        matchedAssertionCount: 0,
        mismatchedAssertionCount: 1,
        notDetectedAssertionCount: 5,
        unrecognizedFileCount: 1
      });
      expect(result.data.suggestedTodos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            title: "Synchronize the current Version declaration in README.md",
            file: "README.md",
            reason: expect.stringContaining(
              "inconsistently with the current RouteLedger truth"
            )
          }),
          expect.objectContaining({
            title: "Add the entry-document pointer: docs/qa/current-checklist.md",
            file: null,
            reason:
              "No entry document points to the expected path docs/qa/current-checklist.md."
          })
        ])
      );
      expect(result.data.summaryText).toContain("Checked 2 entry files for project RouteLedger.");
      expect(result.data.summaryText).toContain(
        `Current version: Version Closeout Plan (${nextVersionId}).`
      );
      expect(result.data.summaryText).toContain(
        "Found 3 warnings and 1 unreadable files."
      );
      expect(result.data.summaryText).toContain("Coverage is partial:");
  });

  it("checkDocDrift compares explicit Chinese current-Version ID, title, and state declarations", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
        contentLocale: "zh-CN",
        name: "PocketRead",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });
      const currentVersion = created.firstVersion!;
      documentSource.setDocument(
        "README.md",
        [
          "当前 Version：V0.1 可靠本地核心",
          "当前 Version ID：wrong-version-id",
          "当前 Version 状态：running"
        ].join("\n"),
      );

      const stale = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(stale.data.warnings).toHaveLength(3);
      expect(stale.data.checkedAssertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "current_version_title", status: "mismatched" }),
          expect.objectContaining({ kind: "current_version_id", status: "mismatched" }),
          expect.objectContaining({ kind: "current_version_state", status: "mismatched" })
        ])
      );
      expect(stale.data.coverage).toMatchObject({
        level: "partial",
        recognizedAssertionCount: 3,
        matchedAssertionCount: 0,
        mismatchedAssertionCount: 3,
        notDetectedAssertionCount: 0,
        unrecognizedFileCount: 0
      });
      expect(stale.data.suggestedTodos).toEqual([
        expect.objectContaining({
          title: "同步 README.md 的 current version 指针",
          file: "README.md",
          reason: expect.stringMatching(
            /current_version_title[\s\S]*current_version_id[\s\S]*current_version_state/
          )
        })
      ]);
      expect(stale.data.coverage.recommendedDeclarationTemplates).toEqual({
        "zh-CN": [
          `当前 Version 标题：${currentVersion.title}`,
          `当前 Version ID：${currentVersion.id}`,
          `当前 Version 状态：${currentVersion.state}`
        ],
        en: [
          `Current Version Title: ${currentVersion.title}`,
          `Current Version ID: ${currentVersion.id}`,
          `Current Version State: ${currentVersion.state}`
        ]
      });

      documentSource.setDocument(
        "README.md",
        ["当前版本发布说明", "当前状态：running"].join("\n"),
      );
      const standaloneAlias = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });
      expect(standaloneAlias.data.checkedAssertions).toContainEqual(
        expect.objectContaining({
          kind: "current_version_state",
          status: "not_detected"
        })
      );

      documentSource.setDocument(
        "README.md",
        [
          `当前 Version 标题：${currentVersion.title}`,
          `当前 Version ID：${currentVersion.id}`,
          `当前状态：${currentVersion.state}`,
          "current pointer source: .routeledger/refs/current.json"
        ].join("\n"),
      );

      const aligned = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(aligned.data.status).toBe("completed");
      expect(aligned.data.warnings).toEqual([]);
      expect(aligned.data.checkedAssertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "current_version_title", status: "matched" }),
          expect.objectContaining({ kind: "current_version_id", status: "matched" }),
          expect.objectContaining({ kind: "current_version_state", status: "matched" })
        ])
      );
      expect(aligned.data.coverage).toMatchObject({
        level: "partial",
        recognizedAssertionCount: 3,
        matchedAssertionCount: 3,
        mismatchedAssertionCount: 0,
        notDetectedAssertionCount: 0
      });
      expect(aligned.data.summaryText).toContain("Coverage is partial:");
  });

  it("checkDocDrift reports not_completed with blocking warnings when every entry file is unreadable", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md", "AGENTS.md"]
      });

      expect(result.data.status).toBe("not_completed");
      expect(result.data.coverage.level).toBe("none");
      expect(result.data.checkedFiles).toEqual([]);
      expect(result.data.unreadableFiles).toHaveLength(2);
      expect(result.data.warnings).toEqual([
        expect.objectContaining({
          code: "UNREADABLE_ENTRY_FILE",
          severity: "blocking",
          file: "README.md"
        }),
        expect.objectContaining({
          code: "UNREADABLE_ENTRY_FILE",
          severity: "blocking",
          file: "AGENTS.md"
        })
      ]);
      expect(result.data.summaryText).toContain("Check status: not_completed.");
      expect(result.data.summaryText).toContain("Coverage is none:");
  });

  it("checkDocDrift requires an injected document source", async () => {
    const storage = new MemoryStorageAdapter();
    const service = new RouteLedgerService({
      storage,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      contentLocale: "en",
      name: "RouteLedger",
      firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
      actor: TEST_ACTOR
    });

    await expect(
      service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      })
    ).rejects.toThrow("checkDocDrift requires RouteLedgerServiceOptions.documentSource");
  });

  it("checkDocDrift 鍦?SQLite 琚啓鎴愬敮涓€鐪熸簮鏃惰繑鍥?STALE_TRUTH_SOURCE", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });

      documentSource.setDocument(
        "README.md",
        "SQLite is the source of truth for the runtime route state.",
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
  });

  it("checkDocDrift 鍦?entry docs 宸插悓姝ユ椂涓嶈繑鍥?warning", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });

      documentSource.setDocument(
        "README.md",
        [
          "# RouteLedger",
          "",
          `褰撳墠鐗堟湰: Initial Version (${created.firstVersion!.id})`,
          "Runtime truth lives in `.routeledger/` canonical JSON.",
          "Capability entrypoint: `docs/capabilities/cap-mcp-route-operations.md`."
        ].join("\n"),
      );
      documentSource.setDocument(
        "docs/capabilities/cap-mcp-route-operations.md",
        "currentVersion -> Initial Version\n"
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
  });

  it("checkDocDrift 鎶?canonical current pointer 鏂囨。瑙嗕负宸插悓姝ワ紝浣嗘棫 current 鏂囨湰浠嶄細鎶?drift", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
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

      documentSource.setDocument(
        "README.md",
        [
          "# RouteLedger",
          "",
          "Current version: see `.routeledger/refs/current.json`."
        ].join("\n"),
      );
      documentSource.setDocument(
        "AGENTS.md",
        [
          "# Agent Entry",
          "",
          "Current version is still Initial Version."
        ].join("\n"),
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
  });

  it("checkDocDrift accepts Windows-style canonical current pointers as synchronized", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
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

      documentSource.setDocument(
        "README.md",
        [
          "# RouteLedger",
          "",
          "Current version: see `.routeledger\\refs\\current.json`.",
          "当前版本：参见 `.routeledger\\refs\\current.json`。"
        ].join("\n"),
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
  });

  it("checkDocDrift rejects suffixed titles, negated states, and stale declarations beside canonical pointers", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
        contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });
      documentSource.setDocument(
        "README.md",
        [
          "Current Version Title: Initial Version old; see `.routeledger/refs/current.json`.",
          "Current Version: not currently wait"
        ].join("\n"),
      );

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(result.data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assertionKind: "current_version_title",
            actual: expect.stringContaining("Initial Version old")
          }),
          expect.objectContaining({
            assertionKind: "current_version_state",
            actual: "not currently wait"
          })
        ])
      );
      expect(result.data.coverage).toMatchObject({
        recognizedAssertionCount: 2,
        matchedAssertionCount: 0,
        mismatchedAssertionCount: 2
      });
  });

  it("checkDocDrift 浼氭嫆缁濊秺鐣?entry file path", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
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
  });

  it("checkDocDrift preserves a host containment failure as an unreadable file", async () => {
    const storage = new MemoryStorageAdapter();
    const documentSource = new MemoryDocumentSource();
    const service = new RouteLedgerService({
      storage,
      documentSource,
      deps: createTestDependencies()
    });

    const created = await service.initProject({
      contentLocale: "en",
        name: "RouteLedger",
        firstVersion: { title: "Initial Version", description: "", initialTodos: [] },
        actor: TEST_ACTOR
      });

      const error = new Error(
        "entry file resolves outside project root via symlink: README.md"
      ) as Error & { code?: string };
      error.code = "ENTRY_FILE_OUTSIDE_PROJECT_ROOT";
      documentSource.setReadError("README.md", error);

      const result = await service.checkDocDrift({
        projectId: created.project.id,
        entryFiles: ["README.md"]
      });

      expect(result.data.checkedFiles).toEqual([]);
      expect(result.data.status).toBe("not_completed");
      expect(result.data.coverage.level).toBe("none");
      expect(result.data.warnings).toEqual([
        expect.objectContaining({
          code: "UNREADABLE_ENTRY_FILE",
          severity: "blocking",
          file: "README.md"
        })
      ]);
      expect(result.data.unreadableFiles).toEqual([
        expect.objectContaining({
          path: "README.md",
          code: "ENTRY_FILE_OUTSIDE_PROJECT_ROOT"
        })
      ]);
  });

  it("carried-forward legacy undo no longer blocks source close but still blocks target start as a due undo", async () => {
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
    const carriedUndo = createUndoFixture({
      id: "legacy-undo-1",
      projectId: prepared.projectId,
      versionId: prepared.versionId,
      originVersionId: prepared.versionId,
      preferredResolutionVersionId: downstreamVersionId,
      status: "wait",
      title: "carry me",
      reason: "defer downstream",
      carriedForwardAt: "2026-06-27T00:00:00.000Z",
      carriedForwardToVersionId: downstreamVersionId
    });
    const snapshot = await storage.loadProjectAggregate(prepared.projectId);
    snapshot!.undos = snapshot!.undos.concat(carriedUndo);
    await storage.saveProjectAggregate(snapshot!);

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
    expect(startGate.dueUndoIds).toEqual([carriedUndo.id]);

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
          recordIds: [carriedUndo.id]
        })
      ]
    });
    expect(defaultData.statusRisks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "START_GATE_BLOCKED",
          severity: "blocking",
          recordIds: [carriedUndo.id]
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
        id: carriedUndo.id
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
      status: "confirmation_required",
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
