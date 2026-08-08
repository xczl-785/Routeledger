import fs from "node:fs";
import path from "node:path";

import { expect, it, describe } from "vitest";

import { acquireRouteLedgerJsonWriteLock, readRouteLedgerJsonDocuments, replaceRouteLedgerJsonDocuments } from "../../../json/src/index.js";
import { createRouteLedgerMcpRegistry } from "../index.js";
import type { createRouteLedgerStdioServer } from "../stdio-server.js";

import { createTempProjectRoot, ensureDefaultWorkspaceConfig, getDefaultDataRoot, getDefaultWorkspaceConfigPath, getDefaultCanonicalJsonRoot, getDefaultJsonProjectPath, getDefaultSqliteDbPath, createRegistry, cleanupProjectRoot, createDeferred, removeSqliteFiles, createSqliteOnlyProject, initializeServer, callTool, getStructuredData, createAndCommitVersion, createApprovedVersionProposal, expectCanonicalJsonValid, setCurrentVersionWithApproval } from "./mcp-test-helpers.js";
describe("routeledger mcp registry", () => {
  it("migrated read-tool adapters preserve success data/meta contracts and keep runtimeContext aligned", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot, {
      hostProfile: "codex"
    });
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      const initData = getStructuredData<{
        project: { id: string };
      }>(initResponse);
      const projectId = initData.project.id;

      const nextVersionId = await createAndCommitVersion(server, projectId, "Doc Drift Current");
      await setCurrentVersionWithApproval(server, projectId, nextVersionId);

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

      const registryContextResponse = await registry.invoke("get_current_context", {
        projectId,
        unknownField: "still-ignored"
      } as any);
      const serverContextResponse = await callTool(
        server,
        "stdio-context",
        "get_current_context",
        {
          projectId
        }
      );
      const registryWindowResponse = await registry.invoke("list_versions_window", {
        projectId,
        extraField: "still-ignored"
      } as any);
      const serverWindowResponse = await callTool(
        server,
        "stdio-window",
        "list_versions_window",
        {
          projectId
        }
      );
      const registryDocDriftResponse = await registry.invoke("check_doc_drift", {
        projectId,
        entryFiles: ["README.md", "AGENTS.md", "docs/missing.md"],
        expectedPointers: [
          {
            kind: "qa",
            path: "docs/qa/current-checklist.md"
          }
        ]
      });
      const serverDocDriftResponse = await callTool(
        server,
        "stdio-doc-drift",
        "check_doc_drift",
        {
          projectId,
          entryFiles: ["README.md", "AGENTS.md", "docs/missing.md"],
          expectedPointers: [
            {
              kind: "qa",
              path: "docs/qa/current-checklist.md"
            }
          ]
        }
      );

      const serverContextStructured = (
        serverContextResponse as {
          result: {
            structuredContent: {
              data: unknown;
              meta: unknown;
            };
          };
        }
      ).result.structuredContent;
      const serverWindowStructured = (
        serverWindowResponse as {
          result: {
            structuredContent: {
              data: unknown;
              meta: unknown;
            };
          };
        }
      ).result.structuredContent;
      const serverDocDriftStructured = (
        serverDocDriftResponse as {
          result: {
            structuredContent: {
              data: unknown;
              meta: unknown;
            };
          };
        }
      ).result.structuredContent;

      expect(Object.keys(registryContextResponse).sort()).toEqual(["data", "meta", "ok"]);
      expect(registryContextResponse).toEqual({
        ok: true,
        data: serverContextStructured.data,
        meta: serverContextStructured.meta
      });
      expect(registryContextResponse.meta).toMatchObject({
        runtimeContext: {
          projectId,
          binding: {
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot
          }
        }
      });

      expect(Object.keys(registryWindowResponse).sort()).toEqual(["data", "meta", "ok"]);
      expect(registryWindowResponse).toEqual({
        ok: true,
        data: serverWindowStructured.data,
        meta: serverWindowStructured.meta
      });
      expect(registryWindowResponse.meta).toMatchObject({
        runtimeContext: {
          projectId,
          binding: {
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot
          }
        }
      });

      expect(Object.keys(registryDocDriftResponse).sort()).toEqual(["data", "meta", "ok"]);
      expect(registryDocDriftResponse).toEqual({
        ok: true,
        data: serverDocDriftStructured.data,
        meta: serverDocDriftStructured.meta
      });
      expect(registryDocDriftResponse.meta).toMatchObject({
        runtimeContext: {
          projectId,
          binding: {
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot
          }
        }
      });
      expect(registryDocDriftResponse.data).toMatchObject({
        routeTruth: {
          currentVersion: {
            id: nextVersionId,
            title: "Doc Drift Current"
          }
        }
      });

    } finally {
      server?.close();
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("registry.invoke returns tool-level INVALID_TOOL_INPUT for migrated read-tool adapters", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const projectId = (initResponse.data as { project: { id: string } }).project.id;

      const invalidContextResponse = await registry.invoke("get_current_context", {
        projectId: 123
      });
      const invalidRootResponse = await registry.invoke("get_current_context", null as any);
      const invalidDocDriftResponse = await registry.invoke("check_doc_drift", {
        projectId,
        entryFiles: "README.md"
      });
      const invalidDocDriftNestedResponse = await registry.invoke("check_doc_drift", {
        projectId,
        entryFiles: ["README.md"],
        expectedPointers: [
          {
            kind: "qa",
            path: "docs/qa/current-checklist.md",
            required: "yes"
          }
        ]
      });
      const invalidWindowResponse = await registry.invoke("list_versions_window", {
        projectId,
        before: "2"
      });
      const permissiveContextResponse = await registry.invoke("get_current_context", {
        projectId,
        unknownField: "pilot-boundary"
      } as any);

      expect(invalidContextResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "get_current_context",
            path: "$.projectId"
          }
        }
      });
      expect(invalidRootResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "get_current_context",
            path: "$.projectId"
          }
        }
      });
      expect(invalidDocDriftResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "check_doc_drift",
            path: "$.entryFiles"
          }
        }
      });
      expect(invalidDocDriftNestedResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "check_doc_drift",
            path: "$.expectedPointers[0].required"
          }
        }
      });
      expect(invalidWindowResponse).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            toolName: "list_versions_window",
            path: "$.before"
          }
        }
      });
      expect(permissiveContextResponse.ok).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context reports uninitialized bindings without requiring projectId", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "uninitialized",
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot,
            workspaceConfigPath: getDefaultWorkspaceConfigPath(projectRoot),
            dataRoot: getDefaultDataRoot(projectRoot),
            routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot)
          },
          processCwd: process.cwd(),
          diagnostics: [],
          storage: {
            mode: "uninitialized",
            hasCanonicalJson: false,
            hasSqlite: false,
            jsonProjectPath: getDefaultJsonProjectPath(projectRoot),
            sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
          },
          activeProject: null,
          hostProfile: "generic",
          actor: {
            id: "mcp-agent",
            displayName: "routeledger-mcp"
          },
          approver: {
            id: "mcp-user",
            displayName: "routeledger-mcp-user"
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context asks for content_locale and proposes the response language", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("get_runtime_context", {
        responseLocale: "zh-CN"
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          contentLocale: {
            status: "confirmation_required",
            configuredValue: null,
            suggestedValue: "zh-CN",
            suggestionSource: "response_locale",
            requiresUserDecision: true,
            effectiveScopes: [
              "project_setting",
              "initial_version_defaults",
              "write_integrity_gate"
            ]
          },
          recommendedNextActions: expect.arrayContaining([
            expect.objectContaining({
              type: "confirm_content_locale",
              proposedValue: "zh-CN",
              requiresUserDecision: true,
              description: "初始化或继续写入前，与用户确认具体 content_locale。"
            }),
            expect.objectContaining({
              type: "initialize_routeledger",
              requiredFields: ["name", "contentLocale"],
              blockedBy: ["content_locale_confirmation"]
            })
          ])
        },
        meta: {
          language: {
            responseLocale: "zh-CN",
            requestedResponseLocale: "zh-CN"
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context stays unbound on process.cwd fallback and does not auto-create workspace config", async () => {
    const workspaceRoot = createTempProjectRoot();
    const previousCwd = process.cwd();
    process.chdir(workspaceRoot);
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const response = await registry.invoke("get_runtime_context", {});
      const cwdAfterChdir = process.cwd();

      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "unbound",
            workspaceRoot: cwdAfterChdir,
            workspaceRootSource: "process_cwd",
            workspaceRootConfidence: "low",
            routeledgerRoot: null
          },
          diagnostics: [
            expect.objectContaining({
              code: "WORKSPACE_ROOT_UNTRUSTED"
            })
          ]
        }
      });
      expect(fs.existsSync(getDefaultWorkspaceConfigPath(workspaceRoot))).toBe(false);
    } finally {
      registry.close();
      process.chdir(previousCwd);
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("get_runtime_context does not create an empty SQLite file and keeps data/meta binding status aligned", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      expect(fs.existsSync(getDefaultSqliteDbPath(projectRoot))).toBe(false);

      const response = await registry.invoke("get_runtime_context", {});

      expect(response.ok).toBe(true);
      expect(fs.existsSync(getDefaultSqliteDbPath(projectRoot))).toBe(false);
      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "uninitialized"
          }
        },
        meta: {
          runtimeContext: {
            binding: {
              status: "uninitialized"
            }
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("malformed workspace config does not crash registry and returns structured invalid diagnostics", async () => {
    const projectRoot = createTempProjectRoot();
    fs.mkdirSync(path.join(projectRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(getDefaultWorkspaceConfigPath(projectRoot), '{"version":1,"dataDir":', "utf8");

    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot
    });

    try {
      const runtimeResponse = await registry.invoke("get_runtime_context", {});
      const discoverResponse = await registry.invoke("discover_routeledger_roots", {});
      const planResponse = await registry.invoke("plan_routeledger_binding", {});
      const initResponse = await registry.invoke("init_project", {
        name: "Broken Config",
        expectedRouteLedgerRoot: projectRoot
      });

      expect(runtimeResponse).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "invalid"
          },
          diagnostics: [
            expect.objectContaining({
              code: "WORKSPACE_CONFIG_MALFORMED_JSON"
            })
          ]
        }
      });
      expect(discoverResponse.ok).toBe(true);
      expect(planResponse.ok).toBe(true);
      expect(initResponse).toMatchObject({
        ok: false,
        error: {
          code: "ROUTELEDGER_BINDING_INVALID"
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("absolute workspace dataDir is rejected as invalid", async () => {
    const workspaceRoot = createTempProjectRoot();
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "/tmp/routeledger-data" }, null, 2)}\n`,
      "utf8"
    );

    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot,
      routeledgerRoot: workspaceRoot
    });

    try {
      const response = await registry.invoke("get_runtime_context", {});
      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "invalid"
          },
          diagnostics: [
            expect.objectContaining({
              code: "WORKSPACE_CONFIG_DATA_DIR_ABSOLUTE"
            })
          ]
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("workspace-outside dataDir is rejected as invalid", async () => {
    const workspaceRoot = createTempProjectRoot();
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "../elsewhere" }, null, 2)}\n`,
      "utf8"
    );

    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot,
      routeledgerRoot: workspaceRoot
    });

    try {
      const response = await registry.invoke("get_runtime_context", {});
      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "invalid"
          },
          diagnostics: [
            expect.objectContaining({
              code: "WORKSPACE_CONFIG_DATA_DIR_OUTSIDE_WORKSPACE"
            })
          ]
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("get_runtime_context reports canonical JSON binding for initialized projects", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger Runtime Context",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);

      const initData = initResponse.data as {
        project: { id: string; name: string; currentVersionId: string | null };
      };
      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "bound",
            workspaceRoot: projectRoot,
            routeledgerRoot: projectRoot
          },
          storage: {
            mode: "json+sqlite",
            hasCanonicalJson: true,
            hasSqlite: true
          },
          activeProject: {
            source: "canonical_json",
            id: initData.project.id,
            name: initData.project.name,
            currentVersionId: initData.project.currentVersionId,
            contentLocale: "en"
          },
          contentLocale: {
            status: "configured",
            configuredValue: "en",
            requiresUserDecision: false,
            effectiveScopes: [
              "project_setting",
              "initial_version_defaults",
              "write_integrity_gate"
            ]
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("legacy null content_locale stays readable, blocks ordinary writes, and can be resolved", async () => {
    const projectRoot = createTempProjectRoot();
    const initialRegistry = createRegistry(projectRoot);

    try {
      const initialized = await initialRegistry.invoke("init_project", {
        name: "Legacy Locale Project",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      const initializedData = initialized.data as {
        project: { id: string };
        initialVersion: { id: string };
      };
      initialRegistry.close();

      const projectPath = getDefaultJsonProjectPath(projectRoot);
      const projectDocument = JSON.parse(fs.readFileSync(projectPath, "utf8")) as {
        settings: Record<string, unknown>;
      };
      delete projectDocument.settings.content_locale;
      fs.writeFileSync(projectPath, `${JSON.stringify(projectDocument, null, 2)}\n`);
      removeSqliteFiles(projectRoot);

      const legacyRegistry = createRegistry(projectRoot);
      try {
        const context = await legacyRegistry.invoke("get_runtime_context", {
          responseLocale: "zh-CN"
        });
        expect(context).toMatchObject({
          ok: true,
          data: {
            activeProject: { contentLocale: null },
            contentLocale: {
              status: "confirmation_required",
              suggestedValue: "zh-CN",
              requiresUserDecision: true
            },
            blockedTools: expect.arrayContaining(["create_todo"]),
            recommendedNextActions: [
              expect.objectContaining({
                type: "set_project_content_locale",
                proposedValue: "zh-CN"
              })
            ]
          }
        });

        const blockedWrite = await legacyRegistry.invoke("create_todo", {
          projectId: initializedData.project.id,
          versionId: initializedData.initialVersion.id,
          title: "应被阻止",
          expectedRouteLedgerRoot: projectRoot
        });
        expect(blockedWrite).toMatchObject({
          ok: false,
          error: { code: "CONTENT_LOCALE_REQUIRED" }
        });

        const resolved = await legacyRegistry.invoke("set_project_content_locale", {
          projectId: initializedData.project.id,
          contentLocale: "zh-cn",
          reason: "用户确认项目内容使用中文",
          expectedRouteLedgerRoot: projectRoot
        });
        expect(resolved).toMatchObject({
          ok: true,
          data: {
            project: {
              settings: { contentLocale: "zh-CN" }
            }
          }
        });
      } finally {
        legacyRegistry.close();
      }
    } finally {
      initialRegistry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context does not clean up interrupted canonical replacement state", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger Runtime Context",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);

      const replacementRoot = path.join(getDefaultCanonicalJsonRoot(projectRoot), ".canonical-replace");
      fs.mkdirSync(path.join(replacementRoot, "next", "todos", "xx"), { recursive: true });
      fs.writeFileSync(
        path.join(replacementRoot, "next", "todos", "xx", "staged.json"),
        "{}",
        "utf8"
      );

      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          storage: {
            mode: "json+sqlite",
            hasCanonicalJson: true
          }
        }
      });
      expect(fs.existsSync(replacementRoot)).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context reports SQLite-only fallback without materializing canonical JSON", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const seeded = await createSqliteOnlyProject(projectRoot);
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);

      const registry = createRegistry(projectRoot);

      try {
        const response = await registry.invoke("get_runtime_context", {});

        expect(response).toMatchObject({
          ok: true,
          data: {
            storage: {
              mode: "sqlite",
              hasCanonicalJson: false,
              hasSqlite: true
            },
            activeProject: {
              source: "sqlite",
              id: seeded.projectId,
              name: "SQLite Only Project",
              currentVersionId: seeded.initialVersionId
            }
          }
        });
        expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);
      } finally {
        registry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("SQLite-disabled runtime ignores legacy SQLite and writes only canonical JSON", async () => {
    const legacyProjectRoot = createTempProjectRoot();
    const jsonProjectRoot = createTempProjectRoot();

    try {
      await createSqliteOnlyProject(legacyProjectRoot);
      const legacyRegistry = createRegistry(legacyProjectRoot, {
        sqliteReadModel: "disabled"
      });

      try {
        const response = await legacyRegistry.invoke("get_runtime_context", {});

        expect(response).toMatchObject({
          ok: true,
          data: {
            storage: {
              mode: "uninitialized",
              sqliteReadModel: "disabled",
              hasCanonicalJson: false,
              hasSqlite: true,
              sqliteError: null
            },
            activeProject: null
          }
        });
      } finally {
        legacyRegistry.close();
      }

      const jsonRegistry = createRegistry(jsonProjectRoot, {
        sqliteReadModel: "disabled"
      });

      try {
        const initResponse = await jsonRegistry.invoke("init_project", {
          name: "JSON Only Runtime",
          expectedRouteLedgerRoot: jsonProjectRoot
        });
        expect(initResponse.ok).toBe(true);

        const contextResponse = await jsonRegistry.invoke("get_runtime_context", {});
        expect(contextResponse).toMatchObject({
          ok: true,
          data: {
            storage: {
              mode: "json",
              sqliteReadModel: "disabled",
              hasCanonicalJson: true,
              hasSqlite: false,
              sqliteError: null
            },
            activeProject: {
              source: "canonical_json",
              name: "JSON Only Runtime"
            }
          }
        });
        const initData = initResponse.data as { project: { id: string } };
        const currentContextResponse = await jsonRegistry.invoke("get_current_context", {
          projectId: initData.project.id
        });
        expect(currentContextResponse.ok).toBe(true);
        expect(fs.existsSync(getDefaultSqliteDbPath(jsonProjectRoot))).toBe(false);
      } finally {
        jsonRegistry.close();
      }
    } finally {
      cleanupProjectRoot(legacyProjectRoot);
      cleanupProjectRoot(jsonProjectRoot);
    }
  });

  it("get_runtime_context reports unreadable SQLite files as sqlite_unavailable", async () => {
    const projectRoot = createTempProjectRoot();
    ensureDefaultWorkspaceConfig(projectRoot);
    const databasePath = getDefaultSqliteDbPath(projectRoot);

    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, "not a sqlite database", "utf8");

    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("get_runtime_context", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          storage: {
            mode: "sqlite_unavailable",
            hasCanonicalJson: false,
            hasSqlite: true
          },
          activeProject: null
        }
      });
      expect(
        (response.data as { storage?: { sqliteError?: unknown } }).storage?.sqliteError
      ).not.toBeNull();
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("get_runtime_context exposes both process cwd and server project root when they differ", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("get_runtime_context", {});
      const data = response.data as {
        processCwd: string;
        binding: {
          workspaceRoot: string;
          routeledgerRoot: string;
        };
      };

      expect(response.ok).toBe(true);
      expect(data.processCwd).toBe(process.cwd());
      expect(data.binding.workspaceRoot).toBe(projectRoot);
      expect(data.binding.routeledgerRoot).toBe(projectRoot);
      expect(data.processCwd).not.toBe(projectRoot);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON-first MCP read tools recover from canonical JSON when SQLite is missing", async () => {
    const projectRoot = createTempProjectRoot();
    const initialRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await initialRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      };

      initialRegistry.close();
      removeSqliteFiles(projectRoot);

      const registry = createRegistry(projectRoot);

      try {
        const contextResponse = await registry.invoke("get_current_context", {
          projectId: initData.project.id
        });
        const versionsWindowResponse = await registry.invoke("list_versions_window", {
          projectId: initData.project.id
        });
        const proposalsResponse = await registry.invoke("list_l3_proposals", {
          projectId: initData.project.id
        });
        const nextActionResponse = await registry.invoke("next_action", {
          projectId: initData.project.id
        });
        const batchPreflightResponse = await registry.invoke("batch_create_versions", {
          projectId: initData.project.id,
          mode: "preflight",
          items: [
            {
              clientKey: "version-2",
              title: "Version 2",
              description: "json-only preflight",
              initialTodos: []
            }
          ]
        });

        expect(contextResponse.ok).toBe(true);
        expect(versionsWindowResponse.ok).toBe(true);
        expect(proposalsResponse.ok).toBe(true);
        expect(nextActionResponse.ok).toBe(true);
        expect(batchPreflightResponse.ok).toBe(true);
        expect((contextResponse.data as { project: { id: string } }).project.id).toBe(
          initData.project.id
        );
        expect(
          (
            batchPreflightResponse.data as {
              headRevision: string;
            }
          ).headRevision
        ).toHaveLength(64);
        expect(
          (versionsWindowResponse.data as { versions: Array<{ id: string }> }).versions.map(
            (version) => version.id
          )
        ).toEqual([initData.initialVersion.id]);
        expect(proposalsResponse.data).toEqual([]);
        expect(
          fs.existsSync(getDefaultSqliteDbPath(projectRoot))
        ).toBe(true);
      } finally {
        registry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON-first MCP returns WRITE_IN_PROGRESS in structuredContent while a writer lock is active", async () => {
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
                project: {
                  id: string;
                };
              };
            };
          };
        }
      ).result.structuredContent.data;
      const writeLock = await acquireRouteLedgerJsonWriteLock(getDefaultDataRoot(projectRoot), {
        ownerId: "busy-writer",
        retryAfterMs: 450,
        staleAfterMs: 30_000
      });

      try {
        const contextResponse = await callTool(server, "context-busy", "get_current_context", {
          projectId: projectData.project.id
        });

        expect(contextResponse).toMatchObject({
          result: {
            isError: true,
            structuredContent: {
              ok: false,
              error: {
                code: "WRITE_IN_PROGRESS",
                details: {
                  projectRoot: path.resolve(getDefaultDataRoot(projectRoot)),
                  retryAfterMs: 450,
                  staleAfterMs: 30_000
                }
              }
            }
          }
        });
      } finally {
        await writeLock.release();
      }

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON-first MCP recovers a stale writer lock instead of staying permanently busy", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const registry = createRegistry(projectRoot);
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      expect(initResponse.ok).toBe(true);
      const projectId = (initResponse.data as { project: { id: string } }).project.id;
      const writeLock = await acquireRouteLedgerJsonWriteLock(getDefaultDataRoot(projectRoot), {
        ownerId: "stale-writer",
        retryAfterMs: 100,
        staleAfterMs: 5
      });
      const metadataPath = path.join(writeLock.lockPath, "metadata.json");
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        updatedAt: string;
      };
      metadata.updatedAt = "2000-01-01T00:00:00.000Z";
      fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

      const contextResponse = await registry.invoke("get_current_context", {
        projectId
      });
      expect(contextResponse.ok).toBe(true);

      const prepareResponse = await registry.invoke("prepare_version", {
        projectId,
        versionId: (initResponse.data as { initialVersion: { id: string } }).initialVersion.id
      });
      expect(prepareResponse.ok).toBe(true);
      expect(fs.existsSync(writeLock.lockPath)).toBe(false);

      registry.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON-first MCP falls back to canonical JSON when SQLite file is corrupted", async () => {
    const projectRoot = createTempProjectRoot();
    const initialRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await initialRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };

      initialRegistry.close();

      const databasePath = getDefaultSqliteDbPath(projectRoot);
      fs.writeFileSync(databasePath, "not-a-valid-sqlite-database", "utf8");
      fs.rmSync(`${databasePath}-wal`, { force: true });
      fs.rmSync(`${databasePath}-shm`, { force: true });

      const registry = createRegistry(projectRoot);

      try {
        const contextResponse = await registry.invoke("get_current_context", {
          projectId: initData.project.id
        });
        const proposalsResponse = await registry.invoke("list_l3_proposals", {
          projectId: initData.project.id
        });

        expect(contextResponse.ok).toBe(true);
        expect(proposalsResponse.ok).toBe(true);
        expect((contextResponse.data as { project: { id: string } }).project.id).toBe(
          initData.project.id
        );
      } finally {
        registry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("MCP write operations update canonical JSON and survive SQLite deletion across restart", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger"
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };
      const baselineDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(projectRoot));

      const createVersionResponse = await registry.invoke("create_version", {
        projectId: initData.project.id,
        title: "Version 2"
      });
      expect(createVersionResponse).toMatchObject({
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED"
        }
      });
      const pendingOperationId = (
        createVersionResponse.error?.details as {
          pendingOperationId: string;
        }
      ).pendingOperationId;

      const approveResponse = await registry.invoke("approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId
      });
      expect(approveResponse.ok).toBe(true);
      const approvalArtifactId = (approveResponse.data as { id: string }).id;

      const commitResponse = await registry.invoke("commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        approvalArtifactId
      });
      expect(commitResponse.ok).toBe(true);
      expect(commitResponse.data).toMatchObject({ replayed: false });

      const replayResponse = await registry.invoke("commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        approvalArtifactId
      });
      expect(replayResponse).toMatchObject({
        ok: true,
        data: {
          pendingOperation: { id: pendingOperationId, status: "committed" },
          approvalArtifact: { id: approvalArtifactId, status: "consumed" },
          replayed: true
        }
      });

      const updatedDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(projectRoot));
      expect(updatedDocuments.length).toBeGreaterThan(baselineDocuments.length);
      expect(updatedDocuments.some((document) => document.content.includes('"title": "Version 2"'))).toBe(
        true
      );

      registry.close();
      removeSqliteFiles(projectRoot);

      const restartedRegistry = createRegistry(projectRoot);

      try {
        const versionsWindowResponse = await restartedRegistry.invoke("list_versions_window", {
          projectId: initData.project.id,
          before: 5,
          after: 5
        });
        expect(versionsWindowResponse.ok).toBe(true);
        expect(
          (versionsWindowResponse.data as { versions: Array<{ title: string }> }).versions.map(
            (version) => version.title
          )
        ).toEqual(["Initial Version", "Version 2"]);
      } finally {
        restartedRegistry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("batch_create_versions propose returns WRITE_IN_PROGRESS while another writer is active", async () => {
    const projectRoot = createTempProjectRoot();
    const setupRegistry = createRegistry(projectRoot);
    const lockAcquired = createDeferred<void>();
    const releaseFirstWriter = createDeferred<void>();
    let shouldHoldWriter = true;
    const firstRegistry = createRegistry(projectRoot, {
      storageTestHooks: {
        afterWriteLockAcquired: async () => {
          if (!shouldHoldWriter) {
            return;
          }

          shouldHoldWriter = false;
          lockAcquired.resolve();
          await releaseFirstWriter.promise;
        }
      }
    });
    const secondRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await setupRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      const initData = initResponse.data as {
        project: { id: string };
      };
      const firstPromise = firstRegistry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ]
      });
      await lockAcquired.promise;

      const second = await secondRegistry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        items: [
          {
            clientKey: "plan-b",
            title: "Plan B",
            description: "batch item B",
            initialTodos: []
          }
        ]
      });
      releaseFirstWriter.resolve();
      const first = await firstPromise;

      expect(first).toMatchObject({
        ok: true,
        data: {
          ok: true,
          pendingOperationId: expect.any(String)
        }
      });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: "WRITE_IN_PROGRESS"
        }
      });
      await expectCanonicalJsonValid(projectRoot);
      const proposals = await secondRegistry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposals.ok).toBe(true);
      expect((proposals.data as Array<{ id: string }>)).toHaveLength(1);
    } finally {
      setupRegistry.close();
      firstRegistry.close();
      secondRegistry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("commit_l3_operation same proposal returns WRITE_IN_PROGRESS while another writer is active", async () => {
    const projectRoot = createTempProjectRoot();
    const setupRegistry = createRegistry(projectRoot);
    const lockAcquired = createDeferred<void>();
    const releaseFirstWriter = createDeferred<void>();
    let shouldHoldWriter = true;
    const firstRegistry = createRegistry(projectRoot, {
      storageTestHooks: {
        afterWriteLockAcquired: async () => {
          if (!shouldHoldWriter) {
            return;
          }

          shouldHoldWriter = false;
          lockAcquired.resolve();
          await releaseFirstWriter.promise;
        }
      }
    });
    const secondRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await setupRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      const projectId = (initResponse.data as { project: { id: string } }).project.id;
      const proposal = await createApprovedVersionProposal(
        setupRegistry,
        projectId,
        "Same Proposal",
        projectRoot
      );
      const firstPromise = firstRegistry.invoke("commit_l3_operation", {
        projectId,
        pendingOperationId: proposal.pendingOperationId,
        approvalArtifactId: proposal.approvalArtifactId
      });
      await lockAcquired.promise;

      const second = await secondRegistry.invoke("commit_l3_operation", {
        projectId,
        pendingOperationId: proposal.pendingOperationId,
        approvalArtifactId: proposal.approvalArtifactId
      });
      releaseFirstWriter.resolve();
      const first = await firstPromise;

      expect(first).toMatchObject({
        ok: true
      });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: "WRITE_IN_PROGRESS"
        }
      });
      await expectCanonicalJsonValid(projectRoot);
    } finally {
      setupRegistry.close();
      firstRegistry.close();
      secondRegistry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("commit_l3_operation different proposals returns WRITE_IN_PROGRESS while another writer is active", async () => {
    const projectRoot = createTempProjectRoot();
    const setupRegistry = createRegistry(projectRoot);
    const lockAcquired = createDeferred<void>();
    const releaseFirstWriter = createDeferred<void>();
    let shouldHoldWriter = true;
    const firstRegistry = createRegistry(projectRoot, {
      storageTestHooks: {
        afterWriteLockAcquired: async () => {
          if (!shouldHoldWriter) {
            return;
          }

          shouldHoldWriter = false;
          lockAcquired.resolve();
          await releaseFirstWriter.promise;
        }
      }
    });
    const secondRegistry = createRegistry(projectRoot);

    try {
      const initResponse = await setupRegistry.invoke("init_project", {
        name: "RouteLedger"
      });
      const projectId = (initResponse.data as { project: { id: string } }).project.id;
      const firstProposal = await createApprovedVersionProposal(
        setupRegistry,
        projectId,
        "Proposal A",
        projectRoot
      );
      const secondProposal = await createApprovedVersionProposal(
        setupRegistry,
        projectId,
        "Proposal B",
        projectRoot
      );
      const firstPromise = firstRegistry.invoke("commit_l3_operation", {
        projectId,
        pendingOperationId: firstProposal.pendingOperationId,
        approvalArtifactId: firstProposal.approvalArtifactId
      });
      await lockAcquired.promise;

      const second = await secondRegistry.invoke("commit_l3_operation", {
        projectId,
        pendingOperationId: secondProposal.pendingOperationId,
        approvalArtifactId: secondProposal.approvalArtifactId
      });
      releaseFirstWriter.resolve();
      const first = await firstPromise;

      expect(first).toMatchObject({
        ok: true
      });
      expect(second).toMatchObject({
        ok: false,
        error: {
          code: "WRITE_IN_PROGRESS"
        }
      });
      await expectCanonicalJsonValid(projectRoot);
    } finally {
      setupRegistry.close();
      firstRegistry.close();
      secondRegistry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("JSON/SQLite project mismatch returns a clear conflict instead of silently overwriting", async () => {
    const sqliteRoot = createTempProjectRoot();
    const jsonRoot = createTempProjectRoot();

    try {
      const sqliteRegistry = createRegistry(sqliteRoot);
      const jsonRegistry = createRegistry(jsonRoot);

      const sqliteInit = await sqliteRegistry.invoke("init_project", {
        name: "SQLite Project"
      });
      const jsonInit = await jsonRegistry.invoke("init_project", {
        name: "JSON Project"
      });

      expect(sqliteInit.ok).toBe(true);
      expect(jsonInit.ok).toBe(true);

      const sqliteProjectId = (sqliteInit.data as { project: { id: string } }).project.id;
      const jsonProjectId = (jsonInit.data as { project: { id: string } }).project.id;
      const jsonDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(jsonRoot));

      await replaceRouteLedgerJsonDocuments({
        outputRoot: getDefaultDataRoot(sqliteRoot),
        documents: jsonDocuments
      });

      sqliteRegistry.close();
      jsonRegistry.close();

      const conflictRegistry = createRegistry(sqliteRoot);

      try {
        const response = await conflictRegistry.invoke("get_current_context", {
          projectId: jsonProjectId
        });

        expect(response).toMatchObject({
          ok: false,
          error: {
            code: "JSON_SQLITE_CONFLICT"
          }
        });
        expect(response.error?.details).toMatchObject({
          canonicalProjectId: jsonProjectId,
          sqliteProjectId: sqliteProjectId
        });
      } finally {
        conflictRegistry.close();
      }
    } finally {
      cleanupProjectRoot(sqliteRoot);
      cleanupProjectRoot(jsonRoot);
    }
  });

  it("config-backed SQLite-only projects still load, and the first MCP write materializes canonical JSON", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const seeded = await createSqliteOnlyProject(projectRoot);
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);

      const registry = createRegistry(projectRoot);

      try {
        const contextResponse = await registry.invoke("get_current_context", {
          projectId: seeded.projectId
        });
        expect(contextResponse.ok).toBe(true);
        expect((contextResponse.data as { project: { id: string } }).project.id).toBe(seeded.projectId);

        const prepareResponse = await registry.invoke("prepare_version", {
          projectId: seeded.projectId,
          versionId: seeded.initialVersionId
        });
        expect(prepareResponse.ok).toBe(true);
      } finally {
        registry.close();
      }

      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(true);

      removeSqliteFiles(projectRoot);

      const restartedRegistry = createRegistry(projectRoot);

      try {
        const contextResponse = await restartedRegistry.invoke("get_current_context", {
          projectId: seeded.projectId
        });
        expect(contextResponse.ok).toBe(true);
      } finally {
        restartedRegistry.close();
      }
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("business failures stay in CallToolResult isError instead of protocol errors", async () => {
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
                project: {
                  id: string;
                };
                initialVersion: {
                  id: string;
                };
              };
            };
          };
        }
      ).result.structuredContent.data;

      await callTool(server, "prepare-version", "prepare_version", {
        projectId: projectData.project.id,
        versionId: projectData.initialVersion.id
      });

      const proposalResponse = await callTool(server, "proposal", "propose_l3_operation", {
        projectId: projectData.project.id,
        actionType: "start_version",
        targetId: projectData.initialVersion.id,
        reason: "start current version"
      });
      const pendingOperationId = (
        proposalResponse as {
          result: {
            structuredContent: {
              data: {
                id: string;
              };
            };
          };
        }
      ).result.structuredContent.data.id;

      const commitResponse = await callTool(server, "commit", "commit_l3_operation", {
        projectId: projectData.project.id,
        pendingOperationId,
        approvalArtifactId: ""
      });

      expect(commitResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "commit",
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

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

});
