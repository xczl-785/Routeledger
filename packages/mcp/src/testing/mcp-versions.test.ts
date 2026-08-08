import fs from "node:fs";
import path from "node:path";

import { expect, it, describe } from "vitest";

import { SQLiteStorageAdapter } from "../../../sqlite/src/index.js";
import { JsonFirstStorageAdapter } from "../json-first-storage.js";
import { createUndoFixture, createWorkItemFixture } from "../../../core/src/testing/builders.js";
import type { createRouteLedgerStdioServer } from "../stdio-server.js";

import { createTempProjectRoot, getDefaultDataRoot, createMismatchedExpectedRouteLedgerRoot, createRegistry, cleanupProjectRoot, readDebugLogRecords, initializeServer, callTool, getStructuredData, createAndCommitVersion, setCurrentVersionWithApproval } from "./mcp-test-helpers.js";
describe("routeledger mcp registry", () => {
  it("check_doc_drift returns structured warnings and unreadable files", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
      }>(initResponse);
      const nextVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Doc Drift Current"
      );

      await setCurrentVersionWithApproval(server, initData.project.id, nextVersionId);

      const legacyUndo = createUndoFixture({
        id: "legacy-doc-drift-undo-1",
        projectId: initData.project.id,
        versionId: nextVersionId,
        originVersionId: nextVersionId,
        preferredResolutionVersionId: nextVersionId,
        workItemId: "legacy-doc-drift-work-item-1",
        title: "Legacy doc-drift audit record",
        reason: "verify default response sanitization"
      });
      const legacyWorkItem = createWorkItemFixture({
        id: "legacy-doc-drift-work-item-1",
        projectId: initData.project.id,
        originVersionId: nextVersionId,
        activeRecordType: "undo",
        activeRecordId: legacyUndo.id
      });
      const storage = new JsonFirstStorageAdapter({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot
      });
      const snapshot = await storage.loadProjectAggregate(initData.project.id);
      snapshot!.undos = snapshot!.undos.concat(legacyUndo);
      snapshot!.workItems = snapshot!.workItems.concat(legacyWorkItem);
      await storage.saveProjectAggregate(snapshot!);
      storage.close();

      fs.writeFileSync(
        path.join(projectRoot, "README.md"),
        ["# RouteLedger", "", "Current docs still mention Initial Version.", "current line is stale."].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        path.join(projectRoot, "AGENTS.md"),
        "# Entry\n鏃?QA 璺緞锛歞ocs/qa/legacy-checklist.md\n",
        "utf8"
      );

      const response = await callTool(server, "check-doc-drift", "check_doc_drift", {
        projectId: initData.project.id,
        entryFiles: ["README.md", "AGENTS.md", "docs/missing.md"],
        expectedPointers: [
          {
            kind: "qa",
            path: "docs/qa/current-checklist.md"
          }
        ]
      });

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: "check-doc-drift",
        result: {
          structuredContent: {
            ok: true,
            data: {
              routeTruth: {
                currentVersion: {
                  id: nextVersionId,
                  title: "Doc Drift Current"
                }
              }
            }
          }
        }
      });

      const data = getStructuredData<{
        routeTruth: Record<string, unknown>;
        legacyAudit: {
          required: boolean;
          guidance: string;
        };
        unreadableFiles: Array<{ path: string; code: string }>;
        warnings: Array<{ code: string; file: string | null; expected?: string }>;
        checkedAssertions: Array<{ kind: string; file: string; status: string }>;
        coverage: {
          level: string;
          recognizedAssertionCount: number;
          notDetectedAssertionCount: number;
        };
        summaryText: string;
      }>(response);

      expect(data.routeTruth).not.toHaveProperty("openUndoCount");
      expect(data.routeTruth).toMatchObject({
        legacyBlockerCount: 1,
        statusRiskCodes: expect.arrayContaining([
          "LEGACY_BLOCKERS_REQUIRE_AUDIT"
        ])
      });
      expect(
        (data.routeTruth.statusRiskCodes as string[]).includes(
          "OPEN_UNDOS_BLOCK_CLOSE"
        )
      ).toBe(false);
      expect(data.legacyAudit).toMatchObject({
        required: true
      });
      expect(data.legacyAudit.guidance).toContain("includeLegacyUndo=true");
      expect(data.summaryText).not.toContain("open undos");
      expect(data.coverage.level).toBe("partial");
      expect(data.coverage.recognizedAssertionCount).toBe(0);
      expect(data.checkedAssertions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "current_version_title",
            file: "README.md",
            status: "not_detected"
          })
        ])
      );
      expect(data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "LEGACY_BLOCKERS_REQUIRE_AUDIT",
            file: null
          })
        ])
      );
      expect(data.unreadableFiles).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "docs/missing.md",
            code: "ENOENT"
          })
        ])
      );
      expect(data.warnings).toEqual(
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

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("check_doc_drift keeps workspaceRoot as the entry-file boundary in split-root mode", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(workspaceRoot, {
        routeledgerRoot
      });
      const initResponse = await callTool(server, "init-split-doc-drift", "init_project", {
        name: "Split Root"
      });
      const initData = getStructuredData<{
        project: { id: string };
      }>(initResponse);
      const nextVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Doc Drift Current"
      );

      await setCurrentVersionWithApproval(server, initData.project.id, nextVersionId);

      fs.writeFileSync(
        path.join(workspaceRoot, "README.md"),
        ["# Workspace entry", "", "Current docs still mention Initial Version.", "current pointer is stale."].join(
          "\n"
        ),
        "utf8"
      );
      fs.writeFileSync(
        path.join(routeledgerRoot, "README.md"),
        [
          "# Docs root",
          "",
          `Current version: Doc Drift Current (${nextVersionId})`,
          ".routeledger/refs/current.json"
        ].join("\n"),
        "utf8"
      );

      const response = await callTool(server, "split-doc-drift", "check_doc_drift", {
        projectId: initData.project.id,
        entryFiles: ["README.md", "docs/README.md"]
      });
      const data = getStructuredData<{
        routeTruth: Record<string, unknown>;
        checkedFiles: Array<{ path: string }>;
        warnings: Array<{ code: string; file: string | null }>;
        unreadableFiles: Array<{ path: string }>;
        summaryText: string;
      }>(response);

      expect(data.routeTruth).not.toHaveProperty("openUndoCount");
      expect(data.routeTruth).toMatchObject({
        legacyBlockerCount: 0
      });
      expect(data).not.toHaveProperty("legacyAudit");
      expect(data.summaryText).not.toContain("open undos");
      expect(data.warnings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "LEGACY_BLOCKERS_REQUIRE_AUDIT"
          })
        ])
      );
      expect(data.checkedFiles.map((file) => file.path)).toEqual([
        "README.md",
        "docs/README.md"
      ]);
      expect(data.unreadableFiles).toEqual([]);
      expect(data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "STALE_CURRENT_VERSION",
            file: "README.md"
          })
        ])
      );
      expect(
        data.warnings.some(
          (warning) =>
            warning.code === "STALE_CURRENT_VERSION" && warning.file === "docs/README.md"
        )
      ).toBe(false);
    } finally {
      server?.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("check_doc_drift rejects invalid entry file paths as tool-level errors", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
      }>(initResponse);
      const response = await callTool(server, "bad-doc-path", "check_doc_drift", {
        projectId: initData.project.id,
        entryFiles: ["../README.md"]
      });

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: "bad-doc-path",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_ASSET_PATH",
              details: {
                field: "entryFiles[0]",
                path: "../README.md"
              }
            }
          }
        }
      });

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("MCP context/version tools honor default window vs explicit full-version contracts", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const projectData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);
      const projectId = projectData.project.id;
      const createdVersionIds = [projectData.initialVersion.id];

      for (const title of [
        "Version 2",
        "Version 3",
        "Version 4",
        "Version 5",
        "Version 6",
        "Version 7",
        "Version 8"
      ]) {
        createdVersionIds.push(await createAndCommitVersion(server, projectId, title));
      }

      await setCurrentVersionWithApproval(server, projectId, createdVersionIds[3]!);

      const defaultContextResponse = await callTool(
        server,
        "default-context",
        "get_current_context",
        {
          projectId
        }
      );
      const fullContextResponse = await callTool(server, "full-context", "get_current_context", {
        projectId,
        includeAllVersions: true
      });
      const listVersionsResponse = await callTool(server, "list-versions", "list_versions", {
        projectId
      });
      const listVersionsWindowResponse = await callTool(
        server,
        "list-versions-window-default",
        "list_versions_window",
        {
          projectId
        }
      );

      const defaultContextData = getStructuredData<{
        versions: Array<{ id: string }>;
      }>(defaultContextResponse);
      const defaultContextMeta = (
        defaultContextResponse as {
          result: {
            structuredContent: {
              meta: {
                versionWindow: {
                  aroundVersionId: string | null;
                  includeAllVersions: boolean;
                  totalCount: number;
                  includedCount: number;
                  omittedBeforeCount: number;
                  omittedAfterCount: number;
                };
              };
            };
          };
        }
      ).result.structuredContent.meta;
      const fullContextData = getStructuredData<{
        versions: Array<{ id: string }>;
      }>(fullContextResponse);
      const fullContextMeta = (
        fullContextResponse as {
          result: {
            structuredContent: {
              meta: {
                versionWindow: {
                  includeAllVersions: boolean;
                  totalCount: number;
                  includedCount: number;
                  omittedBeforeCount: number;
                  omittedAfterCount: number;
                };
              };
            };
          };
        }
      ).result.structuredContent.meta;
      const listVersionsData = getStructuredData<Array<{ id: string }>>(listVersionsResponse);
      const listVersionsWindowData = getStructuredData<{
        aroundVersionId: string | null;
        versions: Array<{ id: string }>;
      }>(listVersionsWindowResponse);
      const listVersionsWindowMeta = (
        listVersionsWindowResponse as {
          result: {
            structuredContent: {
              meta: {
                versionWindow: {
                  totalCount: number;
                  includedCount: number;
                  omittedBeforeCount: number;
                  omittedAfterCount: number;
                };
              };
            };
          };
        }
      ).result.structuredContent.meta;

      expect(defaultContextData.versions.map((version) => version.id)).toEqual(
        createdVersionIds.slice(0, 7)
      );
      expect(defaultContextMeta.versionWindow).toMatchObject({
        aroundVersionId: createdVersionIds[3],
        includeAllVersions: false,
        totalCount: 8,
        includedCount: 7,
        omittedBeforeCount: 0,
        omittedAfterCount: 1
      });

      expect(fullContextData.versions.map((version) => version.id)).toEqual(createdVersionIds);
      expect(fullContextMeta.versionWindow).toMatchObject({
        includeAllVersions: true,
        totalCount: 8,
        includedCount: 8,
        omittedBeforeCount: 0,
        omittedAfterCount: 0
      });

      expect(listVersionsData.map((version) => version.id)).toEqual(createdVersionIds);
      expect(listVersionsWindowData.aroundVersionId).toBe(createdVersionIds[3]);
      expect(listVersionsWindowData.versions.map((version) => version.id)).toEqual(
        createdVersionIds.slice(0, 7)
      );
      expect(listVersionsWindowMeta.versionWindow).toMatchObject({
        totalCount: 8,
        includedCount: 7,
        omittedBeforeCount: 0,
        omittedAfterCount: 1
      });

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("MCP list_versions_window 瑕嗙洊灏鹃儴 anchor 杈圭晫锛屽苟鍦?invalid aroundVersionId 涓婅繑鍥?VERSION_NOT_FOUND", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project-tail-window", "init_project", {
        name: "RouteLedger"
      });
      const projectData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);
      const projectId = projectData.project.id;
      const createdVersionIds = [projectData.initialVersion.id];

      for (const title of [
        "Version 2",
        "Version 3",
        "Version 4",
        "Version 5",
        "Version 6",
        "Version 7",
        "Version 8"
      ]) {
        createdVersionIds.push(await createAndCommitVersion(server, projectId, title));
      }

      const tailWindowResponse = await callTool(
        server,
        "tail-window",
        "list_versions_window",
        {
          projectId,
          aroundVersionId: createdVersionIds[7],
          before: 2,
          after: 3
        }
      );
      const invalidWindowResponse = await callTool(
        server,
        "invalid-window",
        "list_versions_window",
        {
          projectId,
          aroundVersionId: "version-missing",
          before: 2,
          after: 3
        }
      );

      const tailWindowData = getStructuredData<{
        aroundVersionId: string | null;
        versions: Array<{ id: string }>;
      }>(tailWindowResponse);
      const tailWindowMeta = (
        tailWindowResponse as {
          result: {
            structuredContent: {
              meta: {
                versionWindow: {
                  aroundVersionId: string | null;
                  before: number;
                  after: number;
                  totalCount: number;
                  includedCount: number;
                  omittedBeforeCount: number;
                  omittedAfterCount: number;
                };
              };
            };
          };
        }
      ).result.structuredContent.meta;

      expect(tailWindowData.aroundVersionId).toBe(createdVersionIds[7]);
      expect(tailWindowData.versions.map((version) => version.id)).toEqual(
        createdVersionIds.slice(5, 8)
      );
      expect(tailWindowMeta.versionWindow).toMatchObject({
        aroundVersionId: createdVersionIds[7],
        before: 2,
        after: 3,
        totalCount: 8,
        includedCount: 3,
        omittedBeforeCount: 5,
        omittedAfterCount: 0
      });

      expect(invalidWindowResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "invalid-window",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "VERSION_NOT_FOUND"
            }
          }
        }
      });

    } finally {
      server?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions tool schema exposes mode/items/setCurrentTo", () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const tool = registry.getTool("batch_create_versions");

      expect(tool).toBeDefined();
      expect(tool?.inputSchema).toMatchObject({
        type: "object",
        required: ["projectId", "mode", "items"],
        properties: {
          mode: {
            enum: ["preflight", "propose"]
          },
          items: {
            type: "array"
          },
          setCurrentTo: {
            type: "string"
          }
        }
      });
      expect(
        (
          tool?.inputSchema as {
            properties: {
              items: {
                items: {
                  required: string[];
                };
              };
            };
          }
        ).properties.items.items.required
      ).toEqual(["clientKey", "title", "description", "initialTodos"]);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions returns structured preflight/propose results", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
                initialVersion: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const invalidPreflight = await callTool(server, "batch-invalid", "batch_create_versions", {
        projectId: initData.project.id,
        mode: "preflight",
        partialAllowed: true,
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const validPropose = await callTool(server, "batch-propose", "batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        anchor: {
          afterVersionId: initData.initialVersion.id
        },
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: ["write docs"]
          }
        ]
      });

      expect(invalidPreflight).toMatchObject({
        jsonrpc: "2.0",
        id: "batch-invalid",
        result: {
          structuredContent: {
            ok: true,
            data: {
              ok: false,
              code: "BATCH_VERSION_PLAN_INVALID"
            }
          }
        }
      });
      expect(validPropose).toMatchObject({
        jsonrpc: "2.0",
        id: "batch-propose",
        result: {
          structuredContent: {
            ok: true,
            data: {
              ok: true,
              pendingOperationId: expect.any(String)
            }
          }
        }
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 闈炴硶 mode 鍦?MCP 鍗忚灞傝鎷掔粷锛屼笖涓嶄細鍒涘缓 pending proposal", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const invalidMode = await callTool(server, "batch-bad-mode", "batch_create_versions", {
        projectId: initData.project.id,
        mode: "typo",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const contextResponse = await callTool(server, "context-after-bad-mode", "get_current_context", {
        projectId: initData.project.id
      });
      const contextData = getStructuredData<{
        pendingL3Proposals: Array<unknown>;
        versions: Array<{ id: string }>;
      }>(contextResponse);

      expect(invalidMode).toMatchObject({
        jsonrpc: "2.0",
        id: "batch-bad-mode",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.mode"
              }
            }
          }
        }
      });
      expect(contextData.pendingL3Proposals).toEqual([]);
      expect(contextData.versions).toHaveLength(1);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 闈炴硶 mode 鍦?registry.invoke 杩愯鏃惰鎷掔粷锛屼笖涓嶄細鍒涘缓 pending proposal", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      const initData = initResponse.data as {
        project: { id: string };
      };
      const invalidMode = await registry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "typo",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const contextResponse = await registry.invoke("get_current_context", {
        projectId: initData.project.id
      });

      expect(invalidMode).toMatchObject({
        ok: false,
        error: {
          code: "BATCH_CREATE_VERSIONS_MODE_INVALID",
          details: {
            receivedMode: "typo",
            allowedModes: ["preflight", "propose"]
          }
        }
      });
      expect(contextResponse.data).toMatchObject({
        pendingL3Proposals: []
      });
      expect(
        (contextResponse.data as {
          versions: Array<{ id: string }>;
        }).versions
      ).toHaveLength(1);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 闈炴硶 previousCurrentPolicy 鍦?MCP 鍗忚灞傝鎷掔粷锛屼笖涓嶄細鍒涘缓 pending proposal", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const invalidPolicy = await callTool(server, "batch-bad-policy", "batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        previousCurrentPolicy: "typo",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const contextResponse = await callTool(server, "context-after-bad-policy", "get_current_context", {
        projectId: initData.project.id
      });
      const contextData = getStructuredData<{
        pendingL3Proposals: Array<unknown>;
        versions: Array<{ id: string }>;
      }>(contextResponse);

      expect(invalidPolicy).toMatchObject({
        jsonrpc: "2.0",
        id: "batch-bad-policy",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.previousCurrentPolicy"
              }
            }
          }
        }
      });
      expect(contextData.pendingL3Proposals).toEqual([]);
      expect(contextData.versions).toHaveLength(1);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions 闈炴硶 previousCurrentPolicy 鍦?registry.invoke 杩愯鏃惰鎷掔粷锛屼笖涓嶄細鍒涘缓 pending proposal", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      const initData = initResponse.data as {
        project: { id: string };
      };
      const invalidPolicy = await registry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        previousCurrentPolicy: "typo",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      const contextResponse = await registry.invoke("get_current_context", {
        projectId: initData.project.id
      });

      expect(invalidPolicy).toMatchObject({
        ok: false,
        error: {
          code: "BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID",
          details: {
            receivedPreviousCurrentPolicy: "typo",
            allowedPreviousCurrentPolicies: ["leave_as_is", "require_complete_or_close"]
          }
        }
      });
      expect(contextResponse.data).toMatchObject({
        pendingL3Proposals: []
      });
      expect(
        (contextResponse.data as {
          versions: Array<{ id: string }>;
        }).versions
      ).toHaveLength(1);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("transition_version tool follows live state and only proposes the next actionable L3 step", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const targetVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Next Version"
      );

      await callTool(server, "prepare-target", "prepare_version", {
        projectId: initData.project.id,
        versionId: targetVersionId
      });

      const dryRunBeforeSwitch = await callTool(
        server,
        "transition-dry-run-1",
        "transition_version",
        {
          projectId: initData.project.id,
          versionId: targetVersionId
        }
      );

      expect(getStructuredData<{
        nextActionType: string;
        stepsRemaining: string[];
      }>(dryRunBeforeSwitch)).toMatchObject({
        nextActionType: "set_current_version",
        stepsRemaining: ["set_current_version", "start_version"]
      });

      const proposeSwitch = await callTool(server, "transition-propose-1", "transition_version", {
        projectId: initData.project.id,
        versionId: targetVersionId,
        mode: "propose"
      });
      const switchData = getStructuredData<{
        pendingOperationId: string;
        proposedActionType: string;
      }>(proposeSwitch);

      expect(switchData).toMatchObject({
        proposedActionType: "set_current_version",
        pendingOperationId: expect.any(String)
      });

      const approveSwitch = await callTool(server, "approve-switch", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: switchData.pendingOperationId
      });
      const approveSwitchData = getStructuredData<{ id: string }>(approveSwitch);

      await callTool(server, "commit-switch", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: switchData.pendingOperationId,
        approvalArtifactId: approveSwitchData.id
      });

      const dryRunAfterSwitch = await callTool(
        server,
        "transition-dry-run-2",
        "transition_version",
        {
          projectId: initData.project.id,
          versionId: targetVersionId
        }
      );

      expect(getStructuredData<{
        nextActionType: string;
        stepsRemaining: string[];
      }>(dryRunAfterSwitch)).toMatchObject({
        nextActionType: "start_version",
        stepsRemaining: ["start_version"]
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("close_version / carry_forward_undo / get_version_structure tools preserve block-first and downstream-undo semantics", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
                initialVersion: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;

      await callTool(server, "prepare-initial", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const startProposal = await callTool(server, "start-proposal", "propose_l3_operation", {
        projectId: initData.project.id,
        actionType: "start_version",
        targetId: initData.initialVersion.id,
        reason: "start initial"
      });
      const startProposalData = getStructuredData<{ id: string }>(startProposal);
      const approveStart = await callTool(server, "approve-start", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id
      });
      const approveStartData = getStructuredData<{ id: string }>(approveStart);
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id,
        approvalArtifactId: approveStartData.id
      });
      await callTool(server, "complete-initial", "mark_version_complete", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });

      const blockedClose = await callTool(server, "blocked-close", "close_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        mode: "propose"
      });
      const blockedCloseData = getStructuredData<{
        status: string;
        blockers: Array<{ code: string }>;
      }>(blockedClose);
      const proposalList = await callTool(server, "proposal-list", "list_l3_proposals", {
        projectId: initData.project.id
      });
      const proposalListData = getStructuredData<Array<{ status: string }>>(proposalList);
      const legacyUndo = createUndoFixture({
        id: "legacy-version-undo-1",
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        originVersionId: initData.initialVersion.id,
        preferredResolutionVersionId: initData.initialVersion.id,
        workItemId: "legacy-version-work-item-1",
        title: "route later",
        reason: "defer downstream"
      });
      const legacyWorkItem = createWorkItemFixture({
        id: "legacy-version-work-item-1",
        projectId: initData.project.id,
        originVersionId: initData.initialVersion.id,
        activeRecordType: "undo",
        activeRecordId: legacyUndo.id
      });
      const storage = new JsonFirstStorageAdapter({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot
      });
      const snapshot = await storage.loadProjectAggregate(initData.project.id);
      snapshot!.undos = snapshot!.undos.concat(legacyUndo);
      snapshot!.workItems = snapshot!.workItems.concat(legacyWorkItem);
      await storage.saveProjectAggregate(snapshot!);
      storage.close();
      const blockingStructureResponse = await callTool(
        server,
        "blocking-structure",
        "get_version_structure",
        {
          projectId: initData.project.id,
          versionId: initData.initialVersion.id
        }
      );
      const blockingStructureData = getStructuredData<{
        legalOperations: Array<Record<string, any>>;
      }>(blockingStructureResponse);
      const structure = await callTool(server, "structure", "get_version_structure", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const structureData = getStructuredData<{
        legacyAudit: {
          required: boolean;
          recordCount: number;
          guidance: string;
        };
        legalOperations: Array<{ actionType: string }>;
      }>(structure);

      expect(blockedCloseData).toMatchObject({
        status: "blocked",
        blockers: [expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })]
      });
      expect(proposalListData.filter((proposal) => proposal.status === "pending")).toEqual([]);
      expect(structureData).not.toHaveProperty("openUndos");
      expect(structureData.legacyAudit).toMatchObject({
        required: true,
        recordCount: 1
      });
      expect(structureData.legacyAudit.guidance).toContain(
        "includeLegacyUndo=true"
      );
      expect(structureData.legalOperations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionType: "close_version" }),
          expect.objectContaining({ actionType: "review_context" })
        ])
      );
      expect(
        structureData.legalOperations.filter(
          (operation) => operation.actionType === "review_context"
        )
      ).toHaveLength(1);
      const closeOperation = blockingStructureData.legalOperations.find(
        (operation) => operation.actionType === "close_version"
      )!;
      const shutdownOperation = blockingStructureData.legalOperations.find(
        (operation) => operation.actionType === "shutdown_version"
      )!;
      expect(closeOperation).toMatchObject({
        allowed: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({
            code: "LEGACY_WORK_REQUIRES_AUDIT",
            recordCount: 1
          })
        ]),
        details: {
          legacyBlockerCount: 1
        }
      });
      expect(shutdownOperation).toMatchObject({
        details: {
          ordinaryCloseGate: {
            allowed: false,
            legacyBlockerCount: 1,
            blockerCodes: expect.arrayContaining([
              "LEGACY_WORK_REQUIRES_AUDIT"
            ])
          }
        }
      });
      const serializedStructure = JSON.stringify(blockingStructureData);
      expect(serializedStructure).not.toContain("unresolvedUndoIds");
      expect(serializedStructure).not.toContain("OPEN_UNDOS");
      expect(serializedStructure).not.toContain("create_undo");
      expect(serializedStructure).not.toContain("carry_forward_undo");

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_version_transition_guide tool stays read-only, returns metadata, and does not create pending proposals", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
                initialVersion: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const targetVersionId = await createAndCommitVersion(
        server,
        initData.project.id,
        "Next Version"
      );

      await callTool(server, "prepare-current", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const startProposal = await callTool(server, "start-proposal", "propose_l3_operation", {
        projectId: initData.project.id,
        actionType: "start_version",
        targetId: initData.initialVersion.id,
        reason: "start initial"
      });
      const startProposalData = getStructuredData<{ id: string }>(startProposal);
      const approveStart = await callTool(server, "approve-start", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id
      });
      const approveStartData = getStructuredData<{ id: string }>(approveStart);
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id,
        approvalArtifactId: approveStartData.id
      });
      await callTool(server, "complete-current", "mark_version_complete", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      await callTool(server, "prepare-target", "prepare_version", {
        projectId: initData.project.id,
        versionId: targetVersionId
      });

      const guideResponse = await callTool(
        server,
        "transition-guide",
        "get_version_transition_guide",
        {
          projectId: initData.project.id,
          targetVersionId
        }
      );
      const guideData = getStructuredData<{
        status: string;
        closeGate: { blockers: Array<{ code: string }> };
        recommendedSteps: Array<{ stepId: string; status: string; label: string; reason: string }>;
        notes: string[];
      }>(guideResponse);
      const zhGuideData = getStructuredData<{
        recommendedSteps: Array<{ label: string; reason: string }>;
        notes: string[];
      }>(
        await callTool(server, "transition-guide-zh", "get_version_transition_guide", {
          projectId: initData.project.id,
          targetVersionId,
          responseLocale: "zh-CN"
        })
      );
      const proposalList = await callTool(server, "proposal-list-after-guide", "list_l3_proposals", {
        projectId: initData.project.id
      });
      const proposalListData = getStructuredData<Array<{ status: string }>>(proposalList);

      expect(guideResponse).toMatchObject({
        result: {
          structuredContent: {
            meta: {
              runtimeContext: {
                projectId: initData.project.id,
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                }
              },
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              }
            }
          }
        }
      });
      expect(guideData).toMatchObject({
        status: "blocked",
        closeGate: {
          blockers: [expect.objectContaining({ code: "MISSING_RESIDUAL_AUDIT" })]
        }
      });
      expect(guideData.recommendedSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "close-from-version",
            status: "blocked"
          })
        ])
      );
      expect(
        guideData.recommendedSteps.every(
          (step) => !/[\u3400-\u9fff]/u.test(`${step.label} ${step.reason}`)
        )
      ).toBe(true);
      expect(guideData.notes.every((note) => !/[\u3400-\u9fff]/u.test(note))).toBe(true);
      expect(zhGuideData.recommendedSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "关闭来源 Version 边界" })
        ])
      );
      expect(zhGuideData.notes[0]).toBe(
        "这是只读向导，不会创建待决 proposal；请逐步执行列出的现有工具。"
      );
      expect(proposalListData.filter((proposal) => proposal.status === "pending")).toEqual([]);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_version_transition_guide gives lifecycle-specific guidance when current is its own target", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);

      const waitGuide = getStructuredData<{
        status: string;
        closeGate: { applicable: boolean; allowed: boolean };
        startGate: { applicable: boolean; allowed: boolean };
        recommendedSteps: Array<{ stepId: string; actionType: string | null }>;
      }>(
        await callTool(server, "wait-self-guide", "get_version_transition_guide", {
          projectId: initData.project.id,
          targetVersionId: initData.initialVersion.id
        })
      );
      expect(waitGuide).toMatchObject({
        status: "ready",
        closeGate: { applicable: false, allowed: false },
        startGate: { applicable: false, allowed: false },
        recommendedSteps: [
          expect.objectContaining({
            stepId: "prepare-current-version",
            actionType: "prepare_version"
          })
        ]
      });

      await callTool(server, "prepare-current", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const readyGuide = getStructuredData<{
        status: string;
        closeGate: { applicable: boolean };
        recommendedSteps: Array<{ stepId: string; actionType: string | null }>;
      }>(
        await callTool(server, "ready-self-guide", "get_version_transition_guide", {
          projectId: initData.project.id,
          targetVersionId: initData.initialVersion.id
        })
      );
      expect(readyGuide).toMatchObject({
        status: "ready",
        closeGate: { applicable: false }
      });
      expect(readyGuide.recommendedSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "start-current-version",
            actionType: "start_version"
          })
        ])
      );
      expect(readyGuide.recommendedSteps.map((step) => step.actionType)).not.toContain(
        "close_version"
      );

      const startProposal = getStructuredData<{ id: string }>(
        await callTool(server, "start-current", "propose_l3_operation", {
          projectId: initData.project.id,
          actionType: "start_version",
          targetId: initData.initialVersion.id,
          reason: "start initial"
        })
      );
      const startApproval = getStructuredData<{ id: string }>(
        await callTool(server, "approve-start", "approve_l3_operation", {
          projectId: initData.project.id,
          pendingOperationId: startProposal.id
        })
      );
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposal.id,
        approvalArtifactId: startApproval.id
      });

      const runningGuide = getStructuredData<{
        status: string;
        recommendedSteps: unknown[];
      }>(
        await callTool(server, "running-self-guide", "get_version_transition_guide", {
          projectId: initData.project.id,
          targetVersionId: initData.initialVersion.id
        })
      );
      expect(runningGuide).toMatchObject({ status: "noop", recommendedSteps: [] });

      await callTool(server, "complete-current", "mark_version_complete", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const completeGuide = getStructuredData<{
        status: string;
        recommendedSteps: Array<{ stepId: string; actionType: string | null }>;
      }>(
        await callTool(server, "complete-self-guide", "get_version_transition_guide", {
          projectId: initData.project.id,
          targetVersionId: initData.initialVersion.id,
          residualAudit: { status: "reviewed", items: [] }
        })
      );
      expect(completeGuide).toMatchObject({
        status: "ready"
      });
      expect(completeGuide.recommendedSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: "close-current-version",
            actionType: "close_version"
          })
        ])
      );
      expect(completeGuide.recommendedSteps.map((step) => step.actionType)).not.toContain(
        "start_version"
      );

      const closeProposal = getStructuredData<{ pendingOperationId: string }>(
        await callTool(server, "close-current", "close_version", {
          projectId: initData.project.id,
          versionId: initData.initialVersion.id,
          mode: "propose",
          residualAudit: [
            {
              kind: "debt",
              summary: "resolved close routing stays accepted",
              destination: "close"
            }
          ]
        })
      );
      const closeApproval = getStructuredData<{ id: string }>(
        await callTool(server, "approve-close", "approve_l3_operation", {
          projectId: initData.project.id,
          pendingOperationId: closeProposal.pendingOperationId
        })
      );
      await callTool(server, "commit-close", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: closeProposal.pendingOperationId,
        approvalArtifactId: closeApproval.id
      });

      const closedGuide = getStructuredData<{
        status: string;
        closeGate: { applicable: boolean; allowed: boolean };
        startGate: { applicable: boolean; allowed: boolean };
        recommendedSteps: unknown[];
      }>(
        await callTool(server, "closed-self-guide", "get_version_transition_guide", {
          projectId: initData.project.id,
          targetVersionId: initData.initialVersion.id
        })
      );
      expect(closedGuide).toMatchObject({
        status: "noop",
        closeGate: { applicable: false, allowed: true },
        startGate: { applicable: false, allowed: false },
        recommendedSteps: []
      });

      const proposals = getStructuredData<Array<{ status: string }>>(
        await callTool(server, "proposals-after-self-guides", "list_l3_proposals", {
          projectId: initData.project.id
        })
      );
      expect(proposals.filter((proposal) => proposal.status === "pending")).toEqual([]);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("plan_version_closeout tool returns no_op for a closed version and keeps summary.canClose=false", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);

      await callTool(server, "prepare-current", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const startProposal = await callTool(server, "start-proposal", "propose_l3_operation", {
        projectId: initData.project.id,
        actionType: "start_version",
        targetId: initData.initialVersion.id,
        reason: "start initial"
      });
      const startProposalData = getStructuredData<{ id: string }>(startProposal);
      const approveStart = await callTool(server, "approve-start", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id
      });
      const approveStartData = getStructuredData<{ id: string }>(approveStart);
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id,
        approvalArtifactId: approveStartData.id
      });
      await callTool(server, "complete-current", "mark_version_complete", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const closeProposal = await callTool(server, "close-proposal", "close_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        mode: "propose",
        residualAudit: [
          {
            kind: "debt",
            summary: "none",
            destination: "close"
          }
        ]
      });
      const closeProposalData = getStructuredData<{ pendingOperationId: string }>(closeProposal);
      const approveClose = await callTool(server, "approve-close", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: closeProposalData.pendingOperationId
      });
      const approveCloseData = getStructuredData<{ id: string }>(approveClose);
      await callTool(server, "commit-close", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: closeProposalData.pendingOperationId,
        approvalArtifactId: approveCloseData.id
      });

      const planResponse = await callTool(server, "plan-closeout-closed", "plan_version_closeout", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const planData = getStructuredData<{
        status: string;
        summary: {
          canClose: boolean;
          version: { state: string };
        };
        steps: Array<{ kind: string }>;
      }>(planResponse);

      expect(planResponse).toMatchObject({
        result: {
          structuredContent: {
            meta: {
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              }
            }
          }
        }
      });
      expect(planData).toMatchObject({
        status: "no_op",
        summary: {
          canClose: false,
          version: {
            state: "close"
          }
        }
      });
      expect(planData.steps).toEqual([expect.objectContaining({ kind: "no_op" })]);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("Agent-facing Deferred and Constraint tools stay product-simple, persist, and keep legacy tools audit-only", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;
    let registry: ReturnType<typeof createRegistry> | null = null;

    try {
      server = await initializeServer(projectRoot, {
        debugLog: {
          enabled: true
        }
      });
      registry = createRegistry(projectRoot);
      const listedToolNames = registry.tools.map((tool) => tool.name);
      expect(listedToolNames).toEqual(
        expect.arrayContaining([
          "defer_work",
          "review_deferred",
          "record_constraint",
          "retire_constraint"
        ])
      );
      expect(
        listedToolNames.filter((name) => name.includes("undo"))
      ).toEqual([]);
      expect(registry.getTool("create_undo")).toBeUndefined();

      const initResponse = await callTool(server, "agent-init", "init_project", {
        name: "Agent Semantics"
      });
      const initData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);
      const projectId = initData.project.id;
      const downstreamVersionId = await createAndCommitVersion(
        server,
        projectId,
        "Deferred Review"
      );
      const laterVersionId = await createAndCommitVersion(
        server,
        projectId,
        "Later Review"
      );
      const emptyLegacyStructure = await registry.invoke(
        "get_version_structure",
        {
          projectId,
          versionId: initData.initialVersion.id
        }
      );
      const emptyLegacyOperations = (
        emptyLegacyStructure.data as {
          legalOperations: Array<{ actionType: string }>;
        }
      ).legalOperations;
      expect(
        emptyLegacyOperations.some(
          (operation) => operation.actionType === "review_context"
        )
      ).toBe(false);
      expect(
        emptyLegacyOperations.some((operation) =>
          [
            "create_undo",
            "reassign_undo",
            "carry_forward_undo",
            "resolve_undo_as_downstream_input",
            "close_undo"
          ].includes(operation.actionType)
        )
      ).toBe(false);

      const badDefer = await registry.invoke("defer_work", {
        mode: "new",
        projectId,
        currentVersionId: initData.initialVersion.id,
        targetReviewVersionId: downstreamVersionId,
        reason: "missing title"
      });
      expect(badDefer).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            path: "$.title"
          }
        }
      });

      const todoResponse = await callTool(server, "agent-todo", "create_todo", {
        projectId,
        versionId: initData.initialVersion.id,
        title: "Existing work to defer"
      });
      const todoId = getStructuredData<{ todo: { id: string } }>(todoResponse).todo.id;
      const deferredTodoResponse = await callTool(
        server,
        "agent-defer-todo",
        "defer_work",
        {
          mode: "todo",
          projectId,
          todoId,
          targetReviewVersionId: downstreamVersionId,
          reason: "Not needed in the current version",
          note: "Route this Todo to future review"
        }
      );
      const deferredTodoData = getStructuredData<Record<string, any>>(
        deferredTodoResponse
      );
      expect(deferredTodoData).toMatchObject({
        mode: "todo",
        todo: {
          id: todoId,
          status: "converted"
        },
        deferred: {
          status: "pending",
          targetReviewVersionId: downstreamVersionId
        }
      });
      expect(JSON.stringify(deferredTodoData)).not.toContain("workItemId");
      const resolvedTodoDeferred = await callTool(
        server,
        "agent-resolve-todo-deferred",
        "review_deferred",
        {
          projectId,
          deferredId: deferredTodoData.deferred.id,
          action: "resolve",
          outcome: "superseded",
          reason: "A newer product path replaced it",
          note: "No longer needs activation"
        }
      );
      expect(
        getStructuredData<{ deferred: { status: string } }>(
          resolvedTodoDeferred
        ).deferred.status
      ).toBe("resolved");

      const deferredResponse = await callTool(
        server,
        "agent-defer",
        "defer_work",
        {
          mode: "new",
          projectId,
          currentVersionId: initData.initialVersion.id,
          targetReviewVersionId: downstreamVersionId,
          title: "Review product boundary",
          description: "Keep this visible without internal records.",
          reason: "Review after the first delivery"
        }
      );
      const deferredData = getStructuredData<{
        mode: "new";
        deferred: {
          id: string;
          targetReviewVersionId: string;
          workItemId?: string;
          originVersionId?: string;
        };
      }>(deferredResponse);
      expect(deferredData.deferred).toMatchObject({
        targetReviewVersionId: downstreamVersionId
      });
      expect(deferredData.deferred).not.toHaveProperty("workItemId");
      expect(deferredData.deferred).not.toHaveProperty("originVersionId");
      const rejectedWithoutDecision = await registry.invoke("review_deferred", {
        projectId,
        deferredId: deferredData.deferred.id,
        action: "resolve",
        outcome: "rejected",
        reason: "No decision reference"
      });
      expect(rejectedWithoutDecision).toMatchObject({
        ok: false,
        error: {
          code: "MISSING_REQUIRED_FIELD"
        }
      });

      const constraintResponse = await callTool(
        server,
        "agent-constraint",
        "record_constraint",
        {
          projectId,
          rule: "Do not mutate real project data during feature development.",
          rationale: "Migration requires an explicit stop-write window.",
          scopeType: "project"
        }
      );
      const constraintData = getStructuredData<{
        constraint: { id: string; status: string };
      }>(constraintResponse);
      expect(constraintData.constraint.status).toBe("active");
      const badVersionConstraint = await registry.invoke("record_constraint", {
        projectId,
        rule: "Version-only rule",
        rationale: "Missing version ID must fail",
        scopeType: "version"
      });
      expect(badVersionConstraint).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            path: "$.versionId"
          }
        }
      });

      await setCurrentVersionWithApproval(server, projectId, downstreamVersionId);
      await callTool(server, "prepare-review", "prepare_version", {
        projectId,
        versionId: downstreamVersionId
      });
      const dueContextResponse = await callTool(
        server,
        "due-context",
        "get_current_context",
        { projectId }
      );
      const dueContext = getStructuredData<Record<string, any>>(dueContextResponse);
      expect(dueContext.todos).toEqual([]);
      expect(dueContext.deferred).toEqual([
        expect.objectContaining({ id: deferredData.deferred.id })
      ]);
      expect(dueContext.constraints).toEqual([
        expect.objectContaining({ id: constraintData.constraint.id })
      ]);
      expect(dueContext.dueDeferred).toEqual([
        expect.objectContaining({ id: deferredData.deferred.id })
      ]);
      expect(dueContext.nextAction).toMatchObject({
        actionType: "review_deferred",
        targetId: deferredData.deferred.id
      });
      expect(dueContext).not.toHaveProperty("openUndos");
      expect(dueContext).not.toHaveProperty("legacyUndo");
      expect(JSON.stringify(dueContext)).not.toContain("workItemId");
      await callTool(
        server,
        "agent-large-constraint",
        "record_constraint",
        {
          projectId,
          rule: "Keep a deliberately large audit rationale within the context budget.",
          rationale: "evidence ".repeat(2_000),
          scopeType: "project"
        }
      );
      const budgetedContextResponse = await callTool(
        server,
        "agent-budgeted-context",
        "get_current_context",
        {
          projectId,
          budgetBytes: 8192
        }
      );
      const budgetedContext = (
        budgetedContextResponse as {
          result: {
            structuredContent: {
              data: Record<string, any>;
              meta: {
                truncated: boolean;
                truncatedFields: string[];
              };
            };
          };
        }
      ).result.structuredContent;
      expect(budgetedContext.meta).toMatchObject({
        truncated: true,
        truncatedFields: expect.arrayContaining(["constraints.rationale"])
      });
      expect(JSON.stringify(budgetedContext.data)).not.toContain(
        "evidence evidence evidence"
      );

      const deferredAgainResponse = await callTool(
        server,
        "agent-defer-again",
        "review_deferred",
        {
          projectId,
          deferredId: deferredData.deferred.id,
          action: "defer_again",
          targetReviewVersionId: laterVersionId,
          reason: "Needs one more version of evidence",
          note: "reviewed and routed later",
          reviewTrigger: "Later version reaches ready"
        }
      );
      expect(
        getStructuredData<{ deferred: { targetReviewVersionId: string } }>(
          deferredAgainResponse
        ).deferred.targetReviewVersionId
      ).toBe(laterVersionId);

      const activatedResponse = await callTool(
        server,
        "agent-activate",
        "review_deferred",
        {
          projectId,
          deferredId: deferredData.deferred.id,
          action: "activate",
          targetVersionId: laterVersionId,
          reason: "Evidence is available",
          note: "activate as current work"
        }
      );
      const activatedData = getStructuredData<Record<string, any>>(activatedResponse);
      expect(activatedData).toMatchObject({
        action: "activate",
        deferred: {
          status: "activated"
        },
        todo: {
          versionId: laterVersionId
        }
      });
      expect(JSON.stringify(activatedData)).not.toContain("workItemId");

      const retiredResponse = await callTool(
        server,
        "agent-retire-constraint",
        "retire_constraint",
        {
          projectId,
          constraintId: constraintData.constraint.id,
          reason: "Feature window ended",
          note: "Retired after the relevant delivery"
        }
      );
      expect(
        getStructuredData<{ constraint: { status: string } }>(retiredResponse)
          .constraint.status
      ).toBe("retired");
      const productDebugRecords = readDebugLogRecords(projectRoot).filter(
        (record) =>
          typeof record.type === "string" &&
          (record.type.startsWith("deferred.") ||
            record.type.startsWith("constraint."))
      );
      expect(productDebugRecords.map((record) => record.type)).toEqual(
        expect.arrayContaining([
          "deferred.created",
          "deferred.resolve",
          "deferred.defer_again",
          "deferred.activate",
          "constraint.recorded",
          "constraint.retired"
        ])
      );
      expect(JSON.stringify(productDebugRecords)).not.toContain("workItem");

      const mismatchResponse = await registry.invoke("record_constraint", {
        projectId,
        rule: "blocked",
        rationale: "wrong root",
        scopeType: "project",
        expectedRouteLedgerRoot: createMismatchedExpectedRouteLedgerRoot(projectRoot)
      });
      expect(mismatchResponse).toMatchObject({
        ok: false,
        error: {
          code: "MCP_ROUTELEDGER_ROOT_MISMATCH"
        }
      });

      const auditUndo = createUndoFixture({
        id: "legacy-audit-undo-1",
        projectId,
        versionId: initData.initialVersion.id,
        originVersionId: initData.initialVersion.id,
        preferredResolutionVersionId: downstreamVersionId,
        workItemId: "legacy-audit-work-item-1",
        title: "Legacy audit record",
        reason: "compatibility fixture"
      });
      const auditWorkItem = createWorkItemFixture({
        id: "legacy-audit-work-item-1",
        projectId,
        originVersionId: initData.initialVersion.id,
        activeRecordType: "undo",
        activeRecordId: auditUndo.id
      });
      const verbatimUndo = createUndoFixture({
        id: "legacy-verbatim-undo-1",
        projectId,
        versionId: initData.initialVersion.id,
        originVersionId: initData.initialVersion.id,
        preferredResolutionVersionId: initData.initialVersion.id,
        workItemId: "legacy-verbatim-work-item-1",
        title: "User text close_undo must remain verbatim",
        reason: "exercise default read sanitization"
      });
      const verbatimWorkItem = createWorkItemFixture({
        id: "legacy-verbatim-work-item-1",
        projectId,
        originVersionId: initData.initialVersion.id,
        activeRecordType: "undo",
        activeRecordId: verbatimUndo.id
      });
      const storage = new JsonFirstStorageAdapter({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot
      });
      const snapshot = await storage.loadProjectAggregate(projectId);
      snapshot!.undos = snapshot!.undos
        .concat(auditUndo)
        .concat(verbatimUndo);
      snapshot!.workItems = snapshot!.workItems
        .concat(auditWorkItem)
        .concat(verbatimWorkItem);
      await storage.saveProjectAggregate(snapshot!);
      storage.close();
      expect(registry.getTool("create_undo")).toBeUndefined();
      for (const hiddenName of [
        "reassign_undo",
        "resolve_undo_as_downstream_input",
        "close_undo"
      ]) {
        expect(registry.getTool(hiddenName)).toBeUndefined();
      }
      const defaultReadResponses = await Promise.all([
        registry.invoke("get_version_structure", {
          projectId,
          versionId: initData.initialVersion.id
        }),
        registry.invoke("summarize_version_closeout", {
          projectId,
          versionId: initData.initialVersion.id
        }),
        registry.invoke("plan_version_closeout", {
          projectId,
          versionId: initData.initialVersion.id
        })
      ]);
      const structureRead = defaultReadResponses[0]!.data as Record<string, any>;
      const summaryRead = defaultReadResponses[1]!.data as Record<string, any>;
      const planRead = defaultReadResponses[2]!.data as Record<string, any>;
      expect(structureRead).not.toHaveProperty("openUndos");
      expect(structureRead.legacyAudit).toMatchObject({
        required: true,
        recordCount: 2
      });
      const recommendationValues = [
        ...structureRead.legalOperations.map(
          (operation: Record<string, unknown>) => operation.actionType
        ),
        summaryRead.nextAction.actionType,
        summaryRead.nextAction.recommendedTool,
        ...planRead.steps.flatMap((step: Record<string, any>) => [
          step.kind,
          step.recommendedTool,
          ...(step.unlockPaths ?? []).flatMap(
            (unlockPath: Record<string, unknown>) => [
              unlockPath.actionType,
              unlockPath.recommendedTool
            ]
          ),
          ...(step.alternatives ?? []).flatMap(
            (alternative: Record<string, unknown>) => [
              alternative.actionType,
              alternative.recommendedTool
            ]
          )
        ])
      ].filter((value): value is string => typeof value === "string");
      for (const hiddenName of [
        "create_undo",
        "reassign_undo",
        "carry_forward_undo",
        "resolve_undo_as_downstream_input",
        "close_undo"
      ]) {
        expect(
          recommendationValues.some((value) => value.includes(hiddenName))
        ).toBe(false);
      }
      expect(recommendationValues).toContain("review_context");
      expect(
        structureRead.legalOperations.map(
          (operation: Record<string, unknown>) => operation.actionType
        )
      ).toEqual([
        ...new Set(
          structureRead.legalOperations.map(
            (operation: Record<string, unknown>) => operation.actionType
          )
        )
      ]);
      expect(
        summaryRead.openUndos.map(
          (undo: Record<string, unknown>) => undo.title
        )
      ).toContain("User text close_undo must remain verbatim");

      const defaultContext = await registry.invoke("get_current_context", {
        projectId
      });
      expect(defaultContext.ok).toBe(true);
      expect(defaultContext.data).not.toHaveProperty("legacyUndo");
      expect(defaultContext.data).not.toHaveProperty("openUndos");
      expect(defaultContext.data).toMatchObject({
        gates: {
          start: {
            allowed: false,
            blockers: [
              expect.objectContaining({
                code: "LEGACY_WORK_REQUIRES_AUDIT"
              })
            ]
          }
        },
        statusRisks: expect.arrayContaining([
          expect.objectContaining({
            code: "START_GATE_BLOCKED"
          })
        ]),
        nextAction: {
          actionType: "review_context",
          targetId: downstreamVersionId,
          blockingRiskCodes: ["START_GATE_BLOCKED"]
        }
      });
      const auditContext = await registry.invoke("get_current_context", {
        projectId,
        includeLegacyUndo: true
      });
      expect(auditContext.data).toMatchObject({
        legacyUndo: expect.arrayContaining([
          expect.objectContaining({
            title: "Legacy audit record"
          }),
          expect.objectContaining({
            title: "User text close_undo must remain verbatim"
          })
        ]),
        nextAction: {
          actionType: "review_context",
          targetId: downstreamVersionId
        }
      });

      const closeVersionSchema = registry.tools.find(
        (tool) => tool.name === "close_version"
      )!.inputSchema;
      expect(JSON.stringify(closeVersionSchema)).not.toContain("create_undo");
      expect(JSON.stringify(closeVersionSchema)).not.toContain("preferredResolutionVersionId");
      expect(JSON.stringify(closeVersionSchema)).toContain("defer_work");
      expect(JSON.stringify(closeVersionSchema)).toContain("record_constraint");

      server.close();
      server = null;
      registry.close();
      registry = null;
      const reloadedRegistry = createRegistry(projectRoot);
      const reloadedContext = await reloadedRegistry.invoke("get_current_context", {
        projectId
      });
      expect(reloadedContext.ok).toBe(true);
      expect((reloadedContext.data as Record<string, any>).todos).toEqual([
        expect.objectContaining({ versionId: laterVersionId })
      ]);
      reloadedRegistry.close();

      const sqlite = new SQLiteStorageAdapter({
        projectRoot: getDefaultDataRoot(projectRoot)
      });
      const sqliteSnapshot = await sqlite.loadProjectAggregate(projectId);
      expect(sqliteSnapshot?.deferredItems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: deferredData.deferred.id,
            status: "activated"
          })
        ])
      );
      expect(sqliteSnapshot?.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: constraintData.constraint.id,
            status: "retired"
          })
        ])
      );
      sqlite.close();
    } finally {
      server?.close();
      registry?.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("version tree direct MCP tools 鍙垱寤?proposal 骞剁粡 approve/commit 鐢熸晥", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const projectData = (
        initResponse as {
          result: {
            structuredContent: {
              data: {
                project: { id: string };
                initialVersion: { id: string };
              };
            };
          };
        }
      ).result.structuredContent.data;

      const createVersionResponse = await callTool(server, "create-version", "create_version", {
        projectId: projectData.project.id,
        title: "Version 2"
      });
      expect(createVersionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "create-version",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });
      const createVersionDetails = (
        createVersionResponse as {
          result: {
            structuredContent: {
              error: {
                details: {
                  pendingOperationId: string;
                  proposal: { targetId: string };
                };
              };
            };
          };
        }
      ).result.structuredContent.error.details;
      const createVersionApprove = await callTool(server, "approve-create", "approve_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: createVersionDetails.pendingOperationId
      });
      await callTool(server, "commit-create", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: createVersionDetails.pendingOperationId,
        approvalArtifactId: (
          createVersionApprove as {
            result: {
              structuredContent: {
                data: { id: string };
              };
            };
          }
        ).result.structuredContent.data.id
      });

      const insertVersionResponse = await callTool(server, "insert-version", "insert_version", {
        projectId: projectData.project.id,
        title: "Version 1.5",
        afterVersionId: projectData.initialVersion.id
      });
      expect(insertVersionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "insert-version",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });
      const insertVersionDetails = (
        insertVersionResponse as {
          result: {
            structuredContent: {
              error: {
                details: {
                  pendingOperationId: string;
                  proposal: { targetId: string };
                };
              };
            };
          };
        }
      ).result.structuredContent.error.details;
      const insertVersionApprove = await callTool(server, "approve-insert", "approve_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: insertVersionDetails.pendingOperationId
      });
      await callTool(server, "commit-insert", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: insertVersionDetails.pendingOperationId,
        approvalArtifactId: (
          insertVersionApprove as {
            result: {
              structuredContent: {
                data: { id: string };
              };
            };
          }
        ).result.structuredContent.data.id
      });

      const childVersionResponse = await callTool(
        server,
        "create-child-version",
        "create_child_version",
        {
          projectId: projectData.project.id,
          parentVersionId: projectData.initialVersion.id,
          title: "Child 1"
        }
      );
      expect(childVersionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "create-child-version",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });
      const childVersionDetails = (
        childVersionResponse as {
          result: {
            structuredContent: {
              error: {
                details: {
                  pendingOperationId: string;
                  proposal: { targetId: string };
                };
              };
            };
          };
        }
      ).result.structuredContent.error.details;
      const childVersionApprove = await callTool(server, "approve-child", "approve_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: childVersionDetails.pendingOperationId
      });
      await callTool(server, "commit-child", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: childVersionDetails.pendingOperationId,
        approvalArtifactId: (
          childVersionApprove as {
            result: {
              structuredContent: {
                data: { id: string };
              };
            };
          }
        ).result.structuredContent.data.id
      });

      const reorderResponse = await callTool(server, "reorder-version", "reorder_versions", {
        projectId: projectData.project.id,
        versionId: createVersionDetails.proposal.targetId,
        beforeVersionId: insertVersionDetails.proposal.targetId
      });
      expect(reorderResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "reorder-version",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "CONFIRMATION_REQUIRED"
            }
          }
        }
      });
      const reorderDetails = (
        reorderResponse as {
          result: {
            structuredContent: {
              error: {
                details: {
                  pendingOperationId: string;
                };
              };
            };
          };
        }
      ).result.structuredContent.error.details;
      const reorderApprove = await callTool(server, "approve-reorder", "approve_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: reorderDetails.pendingOperationId
      });
      const reorderCommit = await callTool(server, "commit-reorder", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId: reorderDetails.pendingOperationId,
        approvalArtifactId: (
          reorderApprove as {
            result: {
              structuredContent: {
                data: { id: string };
              };
            };
          }
        ).result.structuredContent.data.id
      });

      expect(reorderCommit).toMatchObject({
        jsonrpc: "2.0",
        id: "commit-reorder",
        result: {
          structuredContent: {
            ok: true
          }
        }
      });

      const versionsResponse = await callTool(server, "list-versions", "list_versions", {
        projectId: projectData.project.id
      });
      const versionIds = (
        versionsResponse as {
          result: {
            structuredContent: {
              data: Array<{ id: string }>;
            };
          };
        }
      ).result.structuredContent.data.map((version) => version.id);

      expect(versionIds).toEqual([
        projectData.initialVersion.id,
        childVersionDetails.proposal.targetId,
        createVersionDetails.proposal.targetId,
        insertVersionDetails.proposal.targetId
      ]);

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("shutdown_version tool creates a forced proposal chain and surfaces shutdown state in reads", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });
      const initData = getStructuredData<{
        project: { id: string };
        initialVersion: { id: string };
      }>(initResponse);

      await callTool(server, "prepare-current", "prepare_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const startProposal = await callTool(server, "start-current", "propose_l3_operation", {
        projectId: initData.project.id,
        actionType: "start_version",
        targetId: initData.initialVersion.id,
        reason: "start initial"
      });
      const startProposalData = getStructuredData<{ id: string }>(startProposal);
      const startApproval = await callTool(server, "approve-start", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id
      });
      const startApprovalData = getStructuredData<{ id: string }>(startApproval);
      await callTool(server, "commit-start", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: startProposalData.id,
        approvalArtifactId: startApprovalData.id
      });
      await callTool(server, "create-open-todo", "create_todo", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        title: "still open"
      });

      const shutdownProposal = await callTool(server, "shutdown-proposal", "shutdown_version", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        mode: "propose",
        shutdownReason: "emergency_stop",
        reason: "force close after runtime failure"
      });
      const shutdownProposalData = getStructuredData<{
        status: string;
        forced: boolean;
        shutdownStateReason: string;
        pendingOperationId: string;
        ordinaryCloseGate: { blockers: Array<{ code: string }> };
      }>(shutdownProposal);

      expect(shutdownProposalData).toMatchObject({
        status: "ready",
        forced: true,
        shutdownStateReason: "shutdown:emergency_stop"
      });
      expect(shutdownProposalData.ordinaryCloseGate.blockers).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "TARGET_VERSION_NOT_COMPLETE" })])
      );

      const shutdownApproval = await callTool(server, "approve-shutdown", "approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: shutdownProposalData.pendingOperationId
      });
      const shutdownApprovalData = getStructuredData<{ id: string }>(shutdownApproval);
      await callTool(server, "commit-shutdown", "commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: shutdownProposalData.pendingOperationId,
        approvalArtifactId: shutdownApprovalData.id
      });

      const structure = await callTool(server, "structure-after-shutdown", "get_version_structure", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const structureData = getStructuredData<{
        focusVersion: {
          state: string;
          displayState: string;
          isShutdown: boolean;
          stateReason: string | null;
        };
        legalOperations: Array<{ actionType: string }>;
      }>(structure);
      const closeoutPlan = await callTool(server, "plan-after-shutdown", "plan_version_closeout", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id
      });
      const closeoutPlanData = getStructuredData<{
        version: {
          displayState: string;
          isShutdown: boolean;
          stateReason: string | null;
        };
        steps: Array<{ kind: string }>;
      }>(closeoutPlan);

      expect(structureData.focusVersion).toMatchObject({
        state: "close",
        displayState: "shutdown",
        isShutdown: true,
        stateReason: "shutdown:emergency_stop"
      });
      expect(structureData.legalOperations).toEqual(
        expect.arrayContaining([expect.objectContaining({ actionType: "shutdown_version" })])
      );
      expect(closeoutPlanData.version).toMatchObject({
        displayState: "shutdown",
        isShutdown: true,
        stateReason: "shutdown:emergency_stop"
      });
      expect(closeoutPlanData.steps[0]).toMatchObject({ kind: "no_op" });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });


});
