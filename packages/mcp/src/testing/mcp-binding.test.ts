import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it, describe } from "vitest";

import { acquireRouteLedgerJsonWriteLock, readRouteLedgerJsonDocuments } from "../../../json/src/index.js";
import { MCP_PROTOCOL_VERSION, createRouteLedgerMcpRegistry, type RouteLedgerMcpRegistryOptions, type ToolResponse } from "../index.js";
import { createRouteLedgerStdioServer, type JsonRpcMessage } from "../stdio-server.js";
import { resolveWorkspaceConfigSync } from "../workspace-config.js";
import { resolveRouteLedgerBinding } from "../binding.js";
import { isPhysicalPathContainedWithinSync } from "../physical-path.js";
import { planRouteLedgerBinding, renderHostBindingConfig, writeHostBindingConfig } from "../binding-assist.js";

import { createTempProjectRoot, toForwardSlashes, getDefaultWorkspaceConfigPath, createBindingRegistry, createRegistry, createProcessCwdRegistry, createCapturedServer, cleanupProjectRoot, initializeCanonicalProjectAtRoot, initializeServer, callTool, getStructuredData, expectSingleRootsListRequest, expectRouteLedgerRootGuardError } from "./mcp-test-helpers.js";
describe("routeledger mcp registry", () => {
  it("split-root synthetic acceptance keeps binding, storage paths, and write guards aligned to routeledgerRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(workspaceRoot, {
        routeledgerRoot
      });

      const runtimeBeforeInit = await callTool(server, "runtime-before-init", "get_runtime_context", {});
      expect(runtimeBeforeInit).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot,
                routeledgerRoot,
                workspaceConfigPath: path.join(workspaceRoot, ".routeledger", "config.json"),
                dataRoot: routeledgerRoot,
                routeledgerDir: path.join(routeledgerRoot, ".routeledger")
              },
              storage: {
                mode: "uninitialized",
                dataRoot: routeledgerRoot,
                jsonProjectPath: path.join(routeledgerRoot, ".routeledger", "project.json"),
                sqliteDbPath: path.join(
                  routeledgerRoot,
                  ".routeledger",
                  "db",
                  "routeledger.sqlite3"
                )
              }
            }
          }
        }
      });

      const blockedRead = await callTool(server, "blocked-read", "get_current_context", {
        projectId: "split-root-project"
      });
      expect(blockedRead).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "ROUTELEDGER_NOT_INITIALIZED"
            }
          }
        }
      });

      const mismatchedInit = await callTool(server, "mismatched-init", "init_project", {
        name: "Split Root",
        expectedRouteLedgerRoot: workspaceRoot
      });
      expectRouteLedgerRootGuardError(
        (mismatchedInit as { result: { structuredContent: ToolResponse } }).result
          .structuredContent,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        routeledgerRoot,
        "init_project"
      );
      expect(fs.existsSync(path.join(routeledgerRoot, ".routeledger", "project.json"))).toBe(false);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "config.json"))).toBe(true);

      const initResponse = await callTool(server, "init-split-root", "init_project", {
        name: "Split Root",
        expectedRouteLedgerRoot: routeledgerRoot
      });
      const initData = getStructuredData<{
        project: { id: string };
        firstVersion: { id: string };
      }>(initResponse);

      expect(fs.existsSync(path.join(routeledgerRoot, ".routeledger", "project.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(routeledgerRoot, ".routeledger", "db", "routeledger.sqlite3"))
      ).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "config.json"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "project.json"))).toBe(false);

      const mismatchedCreateTodo = await callTool(server, "mismatched-todo", "create_todo", {
        projectId: initData.project.id,
        versionId: initData.firstVersion!.id,
        title: "blocked by root mismatch",
        idempotencyKey: "split-root-mismatched-todo",
        expectedRouteLedgerRoot: workspaceRoot
      });
      expectRouteLedgerRootGuardError(
        (mismatchedCreateTodo as { result: { structuredContent: ToolResponse } }).result
          .structuredContent,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        routeledgerRoot,
        "create_todo"
      );

      const createTodoResponse = await callTool(server, "matched-todo", "create_todo", {
        projectId: initData.project.id,
        versionId: initData.firstVersion!.id,
        title: "docs follow routeledger root",
        idempotencyKey: "split-root-matched-todo",
        expectedRouteLedgerRoot: routeledgerRoot
      });
      expect(createTodoResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true
          }
        }
      });

      const canonicalDocuments = await readRouteLedgerJsonDocuments(routeledgerRoot);
      expect(canonicalDocuments.some((document) => document.path === ".routeledger/project.json")).toBe(
        true
      );
      expect(
        canonicalDocuments.some((document) =>
          document.path.includes(".routeledger/todos/")
        )
      ).toBe(true);

      const writeLock = await acquireRouteLedgerJsonWriteLock(routeledgerRoot, {
        ownerId: "split-root-writer",
        retryAfterMs: 400,
        staleAfterMs: 30_000
      });

      try {
        const blockedDuringWrite = await callTool(server, "busy-context", "get_current_context", {
          projectId: initData.project.id
        });
        expect(blockedDuringWrite).toMatchObject({
          result: {
            isError: true,
            structuredContent: {
              ok: false,
              error: {
                code: "WRITE_IN_PROGRESS",
                details: {
                  routeledgerRoot
                }
              }
            }
          }
        });

        const runtimeDuringWrite = await callTool(
          server,
          "runtime-during-write",
          "get_runtime_context",
          {}
        );
        expect(runtimeDuringWrite).toMatchObject({
          result: {
            structuredContent: {
              ok: true,
              data: {
                binding: {
                  status: "bound",
                  workspaceRoot,
                  routeledgerRoot
                },
                storage: {
                  mode: "write_in_progress",
                  writeLock: {
                    projectRoot: routeledgerRoot,
                    lockPath: path.join(
                      routeledgerRoot,
                      ".routeledger",
                      ".write-lock"
                    )
                  }
                }
              }
            }
          }
        });
      } finally {
        await writeLock.release();
      }
    } finally {
      server?.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("MCP runtimeContext reports invalid binding when workspaceRoot or routeledgerRoot are relative", async () => {
    const relativeProjectRoot = path.join("relative-root", "project");
    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: relativeProjectRoot,
      routeledgerRoot: relativeProjectRoot
    });

    try {
      const response = await registry.invoke("inspect_runtime", { operation: "runtime" });

      expect(response).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "invalid",
            workspaceRoot: expect.any(String),
            routeledgerRoot: null
          }
        }
      });
      expect(
        path.isAbsolute(
          (response.data as { binding: { workspaceRoot: string } }).binding
            .workspaceRoot
        )
      ).toBe(true);
    } finally {
      registry.close();
    }
  });

  it("discover_routeledger_roots blocks an unbound process cwd until the host supplies workspaceRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);

    try {
      const response = await registry.invoke("discover_routeledger_roots", {});

      expect(response).toMatchObject({
        ok: true,
        data: {
          workspaceRoot: null,
          status: "blocked",
          candidates: [],
          recommendedBinding: null,
          recommendedNextActions: [
            expect.objectContaining({
              type: "provide_explicit_workspace_root",
              tool: "configure_binding"
            })
          ]
        }
      });
      const explicitResponse = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot: resolvedWorkspaceRoot
      });
      expect(explicitResponse).toMatchObject({
        ok: true,
        data: { workspaceRoot: resolvedWorkspaceRoot, status: "none_found" }
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("Codex no-roots session activates an explicit workspace without scanning cache cwd", async () => {
    const cacheCwd = createTempProjectRoot();
    const workspaceRoot = createTempProjectRoot();
    const outsideRoot = createTempProjectRoot();
    const previousCwd = process.cwd();
    process.chdir(cacheCwd);
    const server = createRouteLedgerStdioServer({ hostProfile: "codex" });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "codex-0.144.1-initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { elicitation: {} },
          clientInfo: { name: "codex-mcp-client", version: "0.144.1" }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      expect(getStructuredData<{ status: string }>(
        await callTool(server, "cache-discover", "discover_routeledger_roots", {})
      )).toMatchObject({ status: "blocked" });
      expect(getStructuredData<{ status: string }>(
        await callTool(server, "cache-plan", "plan_routeledger_binding", {})
      )).toMatchObject({ status: "blocked" });
      expect(getStructuredData<{ status: string }>(
        await callTool(server, "explicit-readonly-plan", "plan_routeledger_binding", {
          workspaceRoot,
          routeledgerRoot: workspaceRoot
        })
      )).toMatchObject({ status: "needs_init" });
      expect(fs.existsSync(getDefaultWorkspaceConfigPath(workspaceRoot))).toBe(false);
      expect(getStructuredData<{ status: string }>(
        await callTool(server, "outside-plan", "plan_routeledger_binding", {
          workspaceRoot,
          routeledgerRoot: outsideRoot
        })
      )).toMatchObject({ status: "blocked" });

      const activation = await callTool(
        server,
        "activate-explicit-workspace",
        "activate_routeledger_binding",
        { workspaceRoot }
      );
      const activationData = getStructuredData<{
        status: string;
        rebound: boolean;
        activeBinding: Record<string, unknown>;
      }>(activation);
      expect(activationData).toMatchObject({
        status: "activated",
        rebound: true
      });
      expect(fs.existsSync(getDefaultWorkspaceConfigPath(workspaceRoot))).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "project.json"))).toBe(false);

      const postActivationContext = getStructuredData<{
        binding: Record<string, unknown>;
      }>(
        await callTool(server, "post-activate-context", "get_runtime_context", {})
      );
      expect(postActivationContext).toMatchObject({
        binding: {
          workspaceRoot,
          status: "uninitialized"
        }
      });
      expect(activationData.activeBinding).toMatchObject(
        (activation as {
          result: {
            structuredContent: {
              meta: { runtimeContext: { binding: Record<string, unknown> } };
            };
          };
        }).result.structuredContent.meta.runtimeContext.binding
      );
      expect(activationData.activeBinding).toEqual(postActivationContext.binding);

      const initialized = getStructuredData<{
        project: { id: string };
        firstVersion: { id: string };
      }>(await callTool(server, "activate-init", "init_project", {
        name: "Activated RouteLedger",
        expectedRouteLedgerRoot: workspaceRoot
      }));
      const todo = getStructuredData<{ todo: { id: string } }>(
        await callTool(server, "activate-create-todo", "create_todo", {
          projectId: initialized.project.id,
          versionId: initialized.firstVersion!.id,
          title: "session binding proof",
          idempotencyKey: "activated-session-create",
          expectedRouteLedgerRoot: workspaceRoot
        })
      );
      expect(getStructuredData<unknown>(
        await callTool(server, "activate-close-todo", "close_todo", {
          projectId: initialized.project.id,
          todoId: todo.todo.id,
          reason: "verified",
          note: "session rebind uses the new service",
          idempotencyKey: "activated-session-close",
          expectedRouteLedgerRoot: workspaceRoot
        })
      )).toBeTruthy();

      const switchAttempt = getStructuredData<{ status: string; code: string }>(
        await callTool(server, "reject-bound-switch", "activate_routeledger_binding", {
          workspaceRoot: outsideRoot
        })
      );
      expect(switchAttempt).toMatchObject({
        status: "blocked",
        code: "HIGH_CONFIDENCE_BINDING_SWITCH_REFUSED",
        recommendedNextActions: [
          expect.objectContaining({
            tool: "configure_binding",
            requiresUserDecision: true,
            toolInput: {
              workspaceRoot: outsideRoot,
              routeledgerRoot: outsideRoot,
              confirmProjectSwitch: true
            }
          })
        ]
      });

      const confirmedSwitch = getStructuredData<{
        status: string;
        activeBinding: { workspaceRoot: string; routeledgerRoot: string; status: string };
      }>(
        await callTool(server, "confirm-bound-switch", "activate_routeledger_binding", {
          workspaceRoot: outsideRoot,
          routeledgerRoot: outsideRoot,
          confirmProjectSwitch: true
        })
      );
      expect(confirmedSwitch).toMatchObject({
        status: "activated",
        activeBinding: {
          workspaceRoot: outsideRoot,
          routeledgerRoot: outsideRoot,
          status: "uninitialized"
        }
      });
    } finally {
      server.close();
      process.chdir(previousCwd);
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(outsideRoot);
    }
  });

  it("direct activation returns the swapped registry binding in its own response", async () => {
    const cacheCwd = createTempProjectRoot();
    const workspaceRoot = createTempProjectRoot();
    const registry = createProcessCwdRegistry(cacheCwd, { hostProfile: "codex" });

    try {
      const activation = await registry.invoke("activate_routeledger_binding", { workspaceRoot });
      expect(activation).toMatchObject({
        ok: true,
        data: {
          status: "activated",
          rebound: true,
          activeBinding: {
            workspaceRoot,
            status: "uninitialized"
          }
        },
        meta: {
          runtimeContext: {
            binding: {
              workspaceRoot,
              status: "uninitialized"
            }
          }
        }
      });
      const context = await registry.invoke("get_runtime_context", {});
      expect((activation.data as { activeBinding: unknown }).activeBinding).toEqual(
        (context.data as { binding: unknown }).binding
      );
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("switches an established Codex session only with explicit confirmation", async () => {
    const establishedRoot = createTempProjectRoot();
    const targetRoot = createTempProjectRoot();
    await initializeCanonicalProjectAtRoot(establishedRoot, "Established project");
    await initializeCanonicalProjectAtRoot(targetRoot, "Confirmed target");
    const registry = createRegistry(establishedRoot, { hostProfile: "codex" });

    try {
      const refused = await registry.invoke("activate_routeledger_binding", {
        workspaceRoot: targetRoot,
        routeledgerRoot: targetRoot
      });
      expect(refused).toMatchObject({
        ok: true,
        data: { status: "blocked", code: "HIGH_CONFIDENCE_BINDING_SWITCH_REFUSED" }
      });

      const activated = await registry.invoke("activate_routeledger_binding", {
        workspaceRoot: targetRoot,
        routeledgerRoot: targetRoot,
        confirmProjectSwitch: true
      });
      expect(activated).toMatchObject({
        ok: true,
        data: {
          status: "activated",
          rebound: true,
          previousBinding: { workspaceRoot: establishedRoot },
          activeBinding: { workspaceRoot: targetRoot, routeledgerRoot: targetRoot, status: "bound" }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(establishedRoot);
      cleanupProjectRoot(targetRoot);
    }
  });

  it("direct session rebound error metadata inspects the new binding", async () => {
    const cacheCwd = createTempProjectRoot();
    const targetRoot = createTempProjectRoot();
    const bootstrapRegistry = createRegistry(targetRoot);
    const registry = createProcessCwdRegistry(cacheCwd, { runtimeProfile: "json-only" });
    let bootstrapClosed = false;

    try {
      const initialized = await bootstrapRegistry.invoke("init_project", {
        name: "Rebound Runtime Project"
      });
      const project = (initialized.data as { project: { id: string; name: string } }).project;
      bootstrapRegistry.close();
      bootstrapClosed = true;

      const activated = await registry.invoke("activate_routeledger_binding", {
        workspaceRoot: targetRoot
      });
      expect(activated).toMatchObject({ ok: true, data: { rebound: true } });

      const error = await registry.invoke("list_versions", {
        projectId: "untrusted-request-project"
      });
      expect(error).toMatchObject({
        ok: false,
        error: { code: "PROJECT_NOT_FOUND" },
        meta: {
          runtimeContext: {
            binding: { workspaceRoot: targetRoot, routeledgerRoot: targetRoot },
            projectId: project.id,
            projectName: project.name,
            activeProject: expect.objectContaining({ id: project.id, name: project.name })
          }
        }
      });
    } finally {
      if (!bootstrapClosed) {
        bootstrapRegistry.close();
      }
      registry.close();
      registry.restore();
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(targetRoot);
    }
  });

  it("uses physical containment for links, missing in-workspace children, and workspace dataDir", async () => {
    const workspaceRoot = createTempProjectRoot();
    const outsideRoot = createTempProjectRoot();
    const insideRoot = path.join(workspaceRoot, "inside");
    const outsideLink = path.join(workspaceRoot, "outside-link");
    const insideLink = path.join(workspaceRoot, "inside-link");
    fs.mkdirSync(insideRoot, { recursive: true });

    try {
      fs.symlinkSync(
        outsideRoot,
        outsideLink,
        process.platform === "win32" ? "junction" : "dir"
      );
      fs.symlinkSync(
        insideRoot,
        insideLink,
        process.platform === "win32" ? "junction" : "dir"
      );

      expect(isPhysicalPathContainedWithinSync(workspaceRoot, outsideLink)).toBe(false);
      expect(
        isPhysicalPathContainedWithinSync(
          workspaceRoot,
          `${outsideLink}${path.sep}..${path.sep}escaped-child`
        )
      ).toBe(false);
      expect(isPhysicalPathContainedWithinSync(workspaceRoot, insideLink)).toBe(true);
      expect(
        isPhysicalPathContainedWithinSync(
          workspaceRoot,
          path.join(workspaceRoot, "missing", "child")
        )
      ).toBe(true);
      const missingChild = path.join(workspaceRoot, "missing", "child");
      await expect(
        planRouteLedgerBinding({
          binding: resolveRouteLedgerBinding({}, { autoCreateWorkspaceConfig: false }),
          workspaceRoot,
          routeledgerRoot: missingChild
        })
      ).resolves.toMatchObject({ status: "needs_init" });
      expect(
        resolveRouteLedgerBinding(
          { workspaceRoot, routeledgerRoot: outsideLink },
          { autoCreateWorkspaceConfig: false }
        ).status
      ).toBe("invalid");
      expect(
        resolveRouteLedgerBinding(
          {
            workspaceRoot,
            routeledgerRoot: `${outsideLink}${path.sep}..${path.sep}escaped-child`
          },
          { autoCreateWorkspaceConfig: false }
        ).status
      ).toBe("invalid");

      fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
      fs.writeFileSync(
        getDefaultWorkspaceConfigPath(workspaceRoot),
        `${JSON.stringify({ version: 1, dataDir: "outside-link" })}\n`,
        "utf8"
      );
      expect(
        resolveWorkspaceConfigSync({ projectRoot: workspaceRoot, autoCreate: false })
      ).toMatchObject({
        status: "invalid",
        diagnostics: [
          expect.objectContaining({
            code: "WORKSPACE_CONFIG_DATA_DIR_OUTSIDE_WORKSPACE"
          })
        ]
      });
      fs.writeFileSync(
        getDefaultWorkspaceConfigPath(workspaceRoot),
        `${JSON.stringify({ version: 1, dataDir: "inside-link" })}\n`,
        "utf8"
      );
      expect(
        resolveRouteLedgerBinding(
          { workspaceRoot, routeledgerRoot: insideRoot },
          { autoCreateWorkspaceConfig: false }
        )
      ).toMatchObject({ status: "uninitialized", routeledgerRoot: insideLink });
    } finally {
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(outsideRoot);
    }
  });

  it("keeps the executing registry on session-rebind construction failure and close failure", async () => {
    const cacheCwd = createTempProjectRoot();
    const workspaceRoot = createTempProjectRoot();
    const previousCwd = process.cwd();
    process.chdir(cacheCwd);
    let buildCount = 0;
    let closeAttempted = false;
    let failNextBoundRegistryConstruction = true;
    const server = createRouteLedgerStdioServer({
      hostProfile: "codex",
      registryFactory: (options: RouteLedgerMcpRegistryOptions) => {
        if (
          options.workspaceRoot === workspaceRoot &&
          failNextBoundRegistryConstruction
        ) {
          failNextBoundRegistryConstruction = false;
          throw new Error("injected registry construction failure");
        }
        buildCount += 1;
        const registry = createRouteLedgerMcpRegistry(options);
        if (buildCount !== 2) {
          return registry;
        }
        return {
          ...registry,
          close: () => {
            closeAttempted = true;
            registry.close();
            throw new Error("injected old registry close failure");
          }
        };
      }
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "rebind-failure-initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: "0.144.1" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });

      const failedActivation = await callTool(
        server,
        "injected-rebind-failure",
        "activate_routeledger_binding",
        { workspaceRoot }
      );
      expect(failedActivation).toMatchObject({
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: { code: "SESSION_REBIND_FAILED" },
            meta: {
              runtimeContext: {
                binding: { status: "unbound" },
                projectId: null,
                projectName: null,
                activeProject: null
              }
            }
          },
          _meta: { routeledger: { toolName: "configure_binding" } }
        }
      });
      expect(JSON.stringify(failedActivation)).not.toContain('"activated"');
      expect(JSON.stringify(failedActivation)).not.toContain('"rebound":true');
      expect(getStructuredData<{ binding: { status: string } }>(
        await callTool(server, "rebind-failure-context", "get_runtime_context", {})
      )).toMatchObject({ binding: { status: "unbound" } });

      // The pending request survives the failed construction. A subsequent
      // explicit activation builds the new registry, and an old close failure
      // cannot invalidate its already formed response.
      const successfulActivation = await callTool(
        server,
        "rebind-close-failure",
        "activate_routeledger_binding",
        { workspaceRoot }
      );
      expect(successfulActivation).toMatchObject({
        result: {
          structuredContent: { ok: true, data: { status: "activated", rebound: true } }
        }
      });
      expect(closeAttempted).toBe(true);
      expect(getStructuredData<{ binding: { workspaceRoot: string } }>(
        await callTool(server, "rebind-close-context", "get_runtime_context", {})
      )).toMatchObject({ binding: { workspaceRoot } });
    } finally {
      server.close();
      process.chdir(previousCwd);
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("open_mission_control returns INVALID_TOOL_INPUT when neither binding nor input provides routeledgerRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const registry = createProcessCwdRegistry(workspaceRoot, { hostProfile: "codex" });

    try {
      const response = await registry.invoke("open_mission_control", {});

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            path: "$.routeledgerRoot"
          }
        }
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("open_mission_control rejects routeledgerRoot outside workspaceRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const outsideRoot = createTempProjectRoot();
    const registry = createBindingRegistry({
      workspaceRoot
    });

    try {
      const response = await registry.invoke("open_mission_control", {
        routeledgerRoot: outsideRoot
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: {
            path: "$.routeledgerRoot",
            expected: "routeledgerRoot inside workspaceRoot"
          }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(outsideRoot);
    }
  });

  it("discover_routeledger_roots returns a single candidate with active project summary", async () => {
    const workspaceRoot = createTempProjectRoot();
    const candidateRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(candidateRoot, { recursive: true });
    await initializeCanonicalProjectAtRoot(candidateRoot, "RouteLedger Docs");
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const resolvedCandidateRoot = fs.realpathSync.native(candidateRoot);

    try {
      const response = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot: resolvedWorkspaceRoot
      });

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        workspaceRoot: resolvedWorkspaceRoot,
        status: "single_candidate",
        recommendedBinding: {
          workspaceRoot: resolvedWorkspaceRoot,
          routeledgerRoot: resolvedCandidateRoot,
          requiresUserDecision: false
        }
      });
      const discoveredCandidate = (
        response.data as { candidates: Array<Record<string, unknown>> }
      ).candidates[0]!;
      expect(discoveredCandidate).toMatchObject({
        routeledgerRoot: resolvedCandidateRoot,
        routeledgerDir: path.join(resolvedCandidateRoot, ".routeledger"),
        activeProject: {
          name: "RouteLedger Docs"
        },
        storage: expect.objectContaining({
          hasCanonicalJson: true
        })
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("discover_routeledger_roots and plan_routeledger_binding recognize split-root workspace config targets", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    const bootstrapRegistry = createBindingRegistry({
      workspaceRoot,
      routeledgerRoot
    });
    const registry = createBindingRegistry({
      workspaceRoot
    });

    try {
      const initResponse = await bootstrapRegistry.invoke("init_project", {
        name: "Split Root Discovery"
      });
      expect(initResponse.ok).toBe(true);

      const discoverResponse = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot
      });
      expect(discoverResponse).toMatchObject({
        ok: true,
        data: {
          workspaceRoot,
          status: "single_candidate",
          recommendedBinding: {
            workspaceRoot,
            routeledgerRoot,
            requiresUserDecision: false
          },
          candidates: [
            expect.objectContaining({
              routeledgerRoot,
              dataRoot: routeledgerRoot,
              routeledgerDir: path.join(routeledgerRoot, ".routeledger"),
              workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot)
            })
          ]
        }
      });

      const planResponse = await registry.invoke("plan_routeledger_binding", { workspaceRoot });
      expect(planResponse).toMatchObject({
        ok: true,
        data: {
          status: "ready",
          targetBinding: {
            workspaceRoot,
            routeledgerRoot,
            dataRoot: routeledgerRoot,
            routeledgerDir: path.join(routeledgerRoot, ".routeledger"),
            workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot)
          }
        }
      });
    } finally {
      bootstrapRegistry.close();
      registry.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("discover_routeledger_roots returns ambiguous when multiple candidates exist", async () => {
    const workspaceRoot = createTempProjectRoot();
    const docsRoot = path.join(workspaceRoot, "docs");
    const codeRoot = path.join(workspaceRoot, "code");
    fs.mkdirSync(docsRoot, { recursive: true });
    fs.mkdirSync(codeRoot, { recursive: true });
    await initializeCanonicalProjectAtRoot(docsRoot, "Docs RouteLedger");
    await initializeCanonicalProjectAtRoot(codeRoot, "Code RouteLedger");
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const resolvedDocsRoot = fs.realpathSync.native(docsRoot);
    const resolvedCodeRoot = fs.realpathSync.native(codeRoot);

    try {
      const response = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot: resolvedWorkspaceRoot
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          workspaceRoot: resolvedWorkspaceRoot,
          status: "ambiguous",
          recommendedBinding: null,
          candidates: [
            expect.objectContaining({
              routeledgerRoot: resolvedCodeRoot
            }),
            expect.objectContaining({
              routeledgerRoot: resolvedDocsRoot
            })
          ],
          recommendedNextActions: [
            expect.objectContaining({
              type: "ask_user_for_binding_root"
            })
          ]
        }
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("discover_routeledger_roots surfaces malformed workspace config candidates as risky", async () => {
    const workspaceRoot = createTempProjectRoot();
    const candidateRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(path.join(candidateRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(candidateRoot),
      '{"version":1,"dataDir":',
      "utf8"
    );
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedCandidateRoot = fs.realpathSync.native(candidateRoot);

    try {
      const response = await registry.invoke("discover_routeledger_roots", {
        workspaceRoot: fs.realpathSync.native(workspaceRoot)
      });

      expect(response.ok).toBe(true);
      expect(response.data).toMatchObject({
        status: "single_candidate"
      });
      const discoveredCandidate = (
        response.data as { candidates: Array<Record<string, unknown>> }
      ).candidates[0]!;
      expect(discoveredCandidate).toMatchObject({
        routeledgerRoot: resolvedCandidateRoot,
        storage: {
          mode: "uninitialized"
        },
        risks: [
          expect.objectContaining({
            code: "WORKSPACE_CONFIG_MALFORMED_JSON",
            severity: "error"
          })
        ]
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("plan_routeledger_binding returns needs_init for an in-workspace root without .routeledger", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    const registry = createProcessCwdRegistry(workspaceRoot, { hostProfile: "codex" });
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const resolvedRouteledgerRoot = fs.realpathSync.native(routeledgerRoot);

    try {
      const response = await registry.invoke("plan_routeledger_binding", {
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          status: "needs_init",
          targetBinding: {
            workspaceRoot: resolvedWorkspaceRoot,
            routeledgerRoot: resolvedRouteledgerRoot,
            dataRoot: resolvedRouteledgerRoot,
            routeledgerDir: path.join(resolvedRouteledgerRoot, ".routeledger")
          },
          requiresInit: true,
          requiresHostConfigUpdate: true,
          requiresServerRestart: true,
          sessionActivation: {
            available: true,
            required: true,
            action: "activate_routeledger_binding"
          },
          persistentHostBinding: {
            requiredForFutureSessions: true,
            requiresHostConfigUpdate: true,
            requiresServerRestart: true
          },
          recommendedNextActions: [
            expect.objectContaining({
              type: "activate_session_binding",
              tool: "configure_binding"
            }),
            expect.objectContaining({
              type: "initialize_routeledger",
              tool: "configure_project",
              toolInput: expect.objectContaining({ operation: "initialize" })
            }),
            expect.objectContaining({
              type: "render_codex_config",
              tool: "inspect_runtime",
              toolInput: expect.objectContaining({ operation: "plan_binding" })
            })
          ]
        }
      });
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("plan_routeledger_binding blocks roots outside workspaceRoot", async () => {
    const workspaceRoot = createTempProjectRoot();
    const outsideRoot = createTempProjectRoot();
    const registry = createBindingRegistry({
      workspaceRoot
    });

    try {
      const response = await registry.invoke("plan_routeledger_binding", {
        routeledgerRoot: outsideRoot
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          status: "blocked",
          targetBinding: null,
          checks: [
            expect.objectContaining({
              code: "ROUTELEDGER_ROOT_OUTSIDE_WORKSPACE",
              status: "blocked"
            })
          ]
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(outsideRoot);
    }
  });

  it("plan_routeledger_binding separates Codex session activation from future-session config", async () => {
    const cacheCwd = createTempProjectRoot();
    const targetRoot = createTempProjectRoot();
    await initializeCanonicalProjectAtRoot(targetRoot, "Planned target");
    const unboundRegistry = createProcessCwdRegistry(cacheCwd, { hostProfile: "codex" });
    const boundWorkspaceRoot = createTempProjectRoot();
    await initializeCanonicalProjectAtRoot(boundWorkspaceRoot, "Established binding");
    const boundRegistry = createRegistry(boundWorkspaceRoot, { hostProfile: "codex" });

    try {
      const unboundPlan = await unboundRegistry.invoke("plan_routeledger_binding", {
        workspaceRoot: targetRoot,
        routeledgerRoot: targetRoot
      });
      expect(unboundPlan).toMatchObject({
        ok: true,
        data: {
          status: "ready",
          requiresHostConfigUpdate: true,
          requiresServerRestart: true,
          sessionActivation: {
            available: true,
            required: true,
            action: "activate_routeledger_binding"
          },
          persistentHostBinding: {
            requiredForFutureSessions: true,
            requiresHostConfigUpdate: true,
            requiresServerRestart: true
          },
          recommendedNextActions: [
            expect.objectContaining({ tool: "configure_binding" }),
            expect.objectContaining({
              tool: "inspect_runtime",
              toolInput: expect.objectContaining({ operation: "plan_binding" })
            })
          ]
        }
      });

      const establishedPlan = await boundRegistry.invoke("plan_routeledger_binding", {
        workspaceRoot: boundWorkspaceRoot,
        routeledgerRoot: boundWorkspaceRoot
      });
      expect(establishedPlan).toMatchObject({
        ok: true,
        data: {
          currentBinding: { status: "bound" },
          sessionActivation: {
            available: false,
            required: false,
            action: null
          },
          persistentHostBinding: {
            requiredForFutureSessions: false,
            requiresHostConfigUpdate: false,
            requiresServerRestart: false
          },
          recommendedNextActions: []
        }
      });
      expect(
        (
          establishedPlan.data as {
            recommendedNextActions: Array<{ tool?: string }>;
          }
        ).recommendedNextActions.some((action) => action.tool === "activate_routeledger_binding")
      ).toBe(false);

      const alternatePlan = await boundRegistry.invoke("plan_routeledger_binding", {
        workspaceRoot: targetRoot,
        routeledgerRoot: targetRoot
      });
      expect(alternatePlan).toMatchObject({
        ok: true,
        data: {
          status: "ready",
          currentBinding: { status: "bound" },
          sessionActivation: {
            available: true,
            required: true,
            action: "activate_routeledger_binding"
          },
          recommendedNextActions: [
            expect.objectContaining({
              tool: "configure_binding",
              requiresUserDecision: true,
              toolInput: {
                workspaceRoot: targetRoot,
                routeledgerRoot: targetRoot,
                confirmProjectSwitch: true
              }
            }),
            expect.objectContaining({
              tool: "inspect_runtime",
              toolInput: expect.objectContaining({ operation: "plan_binding" })
            })
          ]
        }
      });
    } finally {
      unboundRegistry.close();
      unboundRegistry.restore();
      boundRegistry.close();
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(targetRoot);
      cleanupProjectRoot(boundWorkspaceRoot);
    }
  });

  it("render_host_binding_config returns Codex config content and fragment plan without writing files", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, ".codex", "config.toml"),
      'existing = "keep-me"\n',
      "utf8"
    );
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedRouteledgerRoot = fs.realpathSync.native(routeledgerRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);

    try {
      const binding = resolveRouteLedgerBinding({
        processCwd: workspaceRoot,
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot
      });
      const blockedWithoutLauncher = await renderHostBindingConfig({
        binding,
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot
      });
      expect(blockedWithoutLauncher).toMatchObject({
        status: "blocked",
        launcherRequirement: {
          code: "STABLE_RUNTIME_LAUNCHER_REQUIRED"
        },
        renderedConfig: null,
        writePlan: null
      });
      const response = await renderHostBindingConfig({
        binding,
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot,
        routeLedgerWorkspaceRoot: process.cwd()
      });

      expect(response).toMatchObject({
        hostProfile: "codex",
        status: "ready",
        bindingPlan: {
          status: "needs_init",
          targetBinding: {
            routeledgerRoot: resolvedRouteledgerRoot
          },
        },
        renderedConfig: {
          format: "toml",
          content: expect.stringContaining('"--routeledger-root"')
        },
        writePlan: {
          kind: "fragment",
          path: path.join(resolvedWorkspaceRoot, ".codex", "routeledger.fragment.toml")
        }
      });
      expect(
        fs.readFileSync(path.join(workspaceRoot, ".codex", "config.toml"), "utf8")
      ).toBe('existing = "keep-me"\n');
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("write_host_binding_config writes a project-level Codex config when none exists", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    const configPath = path.join(workspaceRoot, ".codex", "config.toml");
    const registry = createProcessCwdRegistry(workspaceRoot);
    const resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const resolvedRouteledgerRoot = fs.realpathSync.native(routeledgerRoot);
    const resolvedConfigPath = path.join(resolvedWorkspaceRoot, ".codex", "config.toml");

    try {
      const binding = resolveRouteLedgerBinding({
        processCwd: workspaceRoot,
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot
      });
      const response = await writeHostBindingConfig({
        binding,
        workspaceRoot: resolvedWorkspaceRoot,
        routeledgerRoot: resolvedRouteledgerRoot,
        routeLedgerWorkspaceRoot: process.cwd()
      });

      expect(response).toMatchObject({
        hostProfile: "codex",
        status: "ready",
        bindingPlan: {
          status: "needs_init",
          targetBinding: {
            workspaceRoot: resolvedWorkspaceRoot,
            routeledgerRoot: resolvedRouteledgerRoot
          },
        },
        writeResult: {
          kind: "project-config",
          path: resolvedConfigPath,
          created: true,
          warnings: []
        }
      });
      expect(fs.readFileSync(configPath, "utf8")).toContain('"--workspace-root"');
      expect(fs.readFileSync(configPath, "utf8")).toContain(`"${toForwardSlashes(resolvedWorkspaceRoot)}"`);
      expect(fs.readFileSync(configPath, "utf8")).toContain('"--routeledger-root"');
      expect(fs.readFileSync(configPath, "utf8")).toContain(`"${toForwardSlashes(resolvedRouteledgerRoot)}"`);
    } finally {
      registry.close();
      registry.restore();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("get_runtime_context and blocked write preflight now recommend discover/plan before init or host updates", async () => {
    const uninitializedRoot = createTempProjectRoot();
    const uninitializedRegistry = createBindingRegistry({
      workspaceRoot: uninitializedRoot,
      routeledgerRoot: uninitializedRoot
    });
    const unboundRoot = createTempProjectRoot();
    const unboundRegistry = createProcessCwdRegistry(unboundRoot);

    try {
      const runtimeResponse = await uninitializedRegistry.invoke("get_runtime_context", {});
      expect(runtimeResponse).toMatchObject({
        ok: true,
        data: {
          binding: {
            status: "uninitialized"
          },
          recommendedNextActions: [
            expect.objectContaining({
              type: "confirm_content_locale",
              proposedValue: null,
              requiresUserDecision: true
            }),
            expect.objectContaining({
              type: "inspect_runtime",
              tool: "inspect_runtime",
              toolInput: expect.objectContaining({ operation: "runtime" })
            }),
            expect.objectContaining({
              type: "inspect_workspace",
              tool: "inspect_runtime",
              toolInput: expect.objectContaining({ operation: "discover_roots" })
            }),
            expect.objectContaining({
              type: "plan_binding",
              tool: "inspect_runtime",
              toolInput: expect.objectContaining({ operation: "plan_binding" })
            }),
            expect.objectContaining({
              type: "initialize_routeledger",
              tool: "configure_project",
              toolInput: expect.objectContaining({ operation: "initialize" })
            })
          ]
        }
      });

      const blockedWrite = await unboundRegistry.invoke("create_todo", {
        projectId: "project-1",
        versionId: "version-1",
        title: "todo",
        idempotencyKey: "blocked-unbound-create"
      });
      expect(blockedWrite).toMatchObject({
        ok: false,
        error: {
          code: "ROUTELEDGER_BINDING_REQUIRED",
          details: {
            recommendedNextActions: expect.arrayContaining([
            expect.objectContaining({
              type: "activate_explicit_workspace_binding",
              tool: "configure_binding"
            })
            ])
          }
        }
      });
    } finally {
      uninitializedRegistry.close();
      unboundRegistry.close();
      unboundRegistry.restore();
      cleanupProjectRoot(uninitializedRoot);
      cleanupProjectRoot(unboundRoot);
    }
  });

  it("initialize rootUri binds workspaceRoot from MCP roots and resolves routeledgerRoot from workspace config", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const server = createRouteLedgerStdioServer({
      hostProfile: "codex"
    });

    try {
      const initializeResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          rootUri: pathToFileURL(workspaceRoot).href,
          capabilities: {},
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      expect(initializeResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize"
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const response = await callTool(server, "runtime-context", "get_runtime_context", {});

      expect(response).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                workspaceRootConfidence: "high",
                workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot),
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("roots/list after initialized binds workspaceRoot when initialize omitted rootUri and roots", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex"
    });

    try {
      const initializeResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            roots: {}
          },
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });

      expect(initializeResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize"
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const rootsListRequest = expectSingleRootsListRequest(outboundMessages);

      const listResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: rootsListRequest.id,
        result: {
          roots: [
            {
              uri: pathToFileURL(workspaceRoot).href
            }
          ]
        }
      });

      expect(listResponse).toBeNull();

      const runtimeContextResponse = await callTool(
        server,
        "runtime-context-roots-list",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                workspaceRootConfidence: "high",
                workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot),
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("delayed Roots rebuild retains the old registry on construction failure and survives old close failure", async () => {
    const workspaceA = createTempProjectRoot();
    const workspaceB = createTempProjectRoot();
    let failWorkspaceBOnce = true;
    let oldWorkspaceACloseAttempted = false;
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex",
      registryFactory: (options: RouteLedgerMcpRegistryOptions) => {
        const roots = options.mcpRoots ?? [];
        if (roots.includes(workspaceB) && failWorkspaceBOnce) {
          failWorkspaceBOnce = false;
          throw new Error("injected delayed Roots construction failure");
        }
        const registry = createRouteLedgerMcpRegistry(options);
        if (!roots.includes(workspaceA)) {
          return registry;
        }
        return {
          ...registry,
          close: () => {
            oldWorkspaceACloseAttempted = true;
            registry.close();
            throw new Error("injected delayed Roots old close failure");
          }
        };
      }
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "delayed-roots-initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { roots: {} },
          clientInfo: { name: "vitest", version: "0.0.0" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });

      const rootsRequestA = expectSingleRootsListRequest(outboundMessages);
      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          id: rootsRequestA.id,
          result: { roots: [{ uri: pathToFileURL(workspaceA).href }] }
        })
      ).toBeNull();
      expect(getStructuredData<{ binding: { workspaceRoot: string } }>(
        await callTool(server, "roots-a-context", "get_runtime_context", {})
      )).toMatchObject({ binding: { workspaceRoot: workspaceA } });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });
      const rootsRequestBFailure = outboundMessages[1] as JsonRpcMessage & {
        id: string | number;
      };
      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          id: rootsRequestBFailure.id,
          result: { roots: [{ uri: pathToFileURL(workspaceB).href }] }
        })
      ).toBeNull();
      expect(oldWorkspaceACloseAttempted).toBe(false);
      expect(getStructuredData<{ binding: { workspaceRoot: string } }>(
        await callTool(server, "roots-a-survives-failure", "get_runtime_context", {})
      )).toMatchObject({ binding: { workspaceRoot: workspaceA } });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });
      const rootsRequestBSuccess = outboundMessages[2] as JsonRpcMessage & {
        id: string | number;
      };
      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          id: rootsRequestBSuccess.id,
          result: { roots: [{ uri: pathToFileURL(workspaceB).href }] }
        })
      ).toBeNull();
      expect(oldWorkspaceACloseAttempted).toBe(true);
      expect(getStructuredData<{ binding: { workspaceRoot: string } }>(
        await callTool(server, "roots-b-after-close-failure", "get_runtime_context", {})
      )).toMatchObject({ binding: { workspaceRoot: workspaceB } });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceA);
      cleanupProjectRoot(workspaceB);
    }
  });

  it("roots/list errors do not crash and initialize rootUri binding remains authoritative", async () => {
    const workspaceRoot = createTempProjectRoot();
    const alternateWorkspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          rootUri: pathToFileURL(workspaceRoot).href,
          capabilities: {
            roots: {}
          },
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const rootsListRequest = expectSingleRootsListRequest(outboundMessages);

      expect(
        await server.handleMessage({
          jsonrpc: "2.0",
          id: rootsListRequest.id,
          error: {
            code: -32601,
            message: "Method not found"
          }
        })
      ).toBeNull();

      const runtimeContextResponse = await callTool(
        server,
        "runtime-context-rooturi-survives-error",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });

      expect(outboundMessages).toHaveLength(2);
      const refreshRequest = outboundMessages[1] as JsonRpcMessage & {
        id: string | number;
      };
      expect(refreshRequest).toMatchObject({
        jsonrpc: "2.0",
        method: "roots/list"
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        id: refreshRequest.id,
        result: {
          roots: [
            {
              uri: pathToFileURL(alternateWorkspaceRoot).href
            }
          ]
        }
      });

      const runtimeContextAfterRefresh = await callTool(
        server,
        "runtime-context-rooturi-survives-refresh",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextAfterRefresh).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
      cleanupProjectRoot(alternateWorkspaceRoot);
    }
  });

  it("roots/list_changed empty or invalid roots do not clear the last valid listed root binding", async () => {
    const workspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(workspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(workspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            roots: {}
          },
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const firstRequest = expectSingleRootsListRequest(outboundMessages);
      await server.handleMessage({
        jsonrpc: "2.0",
        id: firstRequest.id,
        result: {
          roots: [{ uri: pathToFileURL(workspaceRoot).href }]
        }
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });

      const emptyRequest = outboundMessages[1] as JsonRpcMessage & {
        id: string | number;
      };
      await server.handleMessage({
        jsonrpc: "2.0",
        id: emptyRequest.id,
        result: {
          roots: []
        }
      });

      let runtimeContextResponse = await callTool(
        server,
        "runtime-context-roots-empty-preserves-binding",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });

      const invalidRequest = outboundMessages[2] as JsonRpcMessage & {
        id: string | number;
      };
      await server.handleMessage({
        jsonrpc: "2.0",
        id: invalidRequest.id,
        result: {
          roots: [
            { uri: "https://example.com/not-a-file-root" },
            { uri: "not-a-uri" },
            {}
          ]
        }
      });

      runtimeContextResponse = await callTool(
        server,
        "runtime-context-roots-invalid-preserves-binding",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("latest roots/list response wins when earlier request returns after a newer refresh", async () => {
    const oldWorkspaceRoot = createTempProjectRoot();
    const newWorkspaceRoot = createTempProjectRoot();
    const routeledgerRoot = path.join(newWorkspaceRoot, "docs");
    fs.mkdirSync(routeledgerRoot, { recursive: true });
    fs.mkdirSync(path.join(newWorkspaceRoot, ".routeledger"), { recursive: true });
    fs.writeFileSync(
      getDefaultWorkspaceConfigPath(newWorkspaceRoot),
      `${JSON.stringify({ version: 1, dataDir: "docs" }, null, 2)}\n`,
      "utf8"
    );
    const { server, outboundMessages } = createCapturedServer({
      hostProfile: "codex"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            roots: {}
          },
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const requestA = expectSingleRootsListRequest(outboundMessages);

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });

      const requestB = outboundMessages[1] as JsonRpcMessage & {
        id: string | number;
      };
      expect(requestB).toMatchObject({
        jsonrpc: "2.0",
        method: "roots/list"
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        id: requestB.id,
        result: {
          roots: [{ uri: pathToFileURL(newWorkspaceRoot).href }]
        }
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        id: requestA.id,
        result: {
          roots: [{ uri: pathToFileURL(oldWorkspaceRoot).href }]
        }
      });

      const runtimeContextResponse = await callTool(
        server,
        "runtime-context-latest-roots-list-wins",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                workspaceRoot: newWorkspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot,
                dataRoot: routeledgerRoot
              }
            }
          }
        }
      });

      const malformedResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: requestB.id,
        result: undefined,
        error: {
          code: -32600,
          message: "should fail validation"
        }
      });
      expect(malformedResponse).toMatchObject({
        jsonrpc: "2.0",
        id: requestB.id,
        error: {
          code: -32600
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(oldWorkspaceRoot);
      cleanupProjectRoot(newWorkspaceRoot);
    }
  });

  it("configure_binding returns current public follow-ups after activating an uninitialized root", async () => {
    const cacheCwd = createTempProjectRoot();
    const workspaceRoot = createTempProjectRoot();
    const previousCwd = process.cwd();
    process.chdir(cacheCwd);
    const server = createRouteLedgerStdioServer({ hostProfile: "codex" });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "public-binding-initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: "0.144.1" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });

      const activation = await callTool(
        server,
        "activate-public-binding",
        "configure_binding",
        { workspaceRoot, routeledgerRoot: workspaceRoot }
      );
      const activationData = getStructuredData<{
        status: string;
        rebound: boolean;
        activeBinding: { status: string; workspaceRoot: string; routeledgerRoot: string };
        bindingPlan: {
          requiresHostConfigUpdate: boolean;
          requiresServerRestart: boolean;
          sessionActivation: { available: boolean; required: boolean; action: string | null };
          persistentHostBinding: {
            requiredForFutureSessions: boolean;
            requiresHostConfigUpdate: boolean;
            requiresServerRestart: boolean;
          };
          recommendedNextActions: Array<{
            type: string;
            tool?: string;
            toolInput?: { operation?: string };
          }>;
        };
      }>(activation);

      expect(activationData).toMatchObject({
        status: "activated",
        rebound: true,
        activeBinding: {
          status: "uninitialized",
          workspaceRoot,
          routeledgerRoot: workspaceRoot
        },
        bindingPlan: {
          requiresHostConfigUpdate: false,
          requiresServerRestart: false,
          sessionActivation: {
            available: false,
            required: false,
            action: null
          },
          persistentHostBinding: {
            requiredForFutureSessions: false,
            requiresHostConfigUpdate: false,
            requiresServerRestart: false
          },
          recommendedNextActions: [
            expect.objectContaining({
              type: "initialize_routeledger",
              tool: "configure_project",
              toolInput: expect.objectContaining({ operation: "initialize" })
            })
          ]
        }
      });
      expect(JSON.stringify(activation)).not.toContain("activate_routeledger_binding");
      expect(JSON.stringify(activation)).not.toContain("init_project");
    } finally {
      server.close();
      process.chdir(previousCwd);
      cleanupProjectRoot(cacheCwd);
      cleanupProjectRoot(workspaceRoot);
    }
  });

  it("initialize rootUri on a fresh workspace bootstraps default config and allows init_project", async () => {
    const workspaceRoot = createTempProjectRoot();
    const server = createRouteLedgerStdioServer({
      hostProfile: "codex"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          rootUri: pathToFileURL(workspaceRoot).href,
          capabilities: {},
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const runtimeContextResponse = await callTool(
        server,
        "runtime-context-fresh-rooturi",
        "get_runtime_context",
        {}
      );
      expect(runtimeContextResponse).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              binding: {
                status: "uninitialized",
                workspaceRoot,
                workspaceRootSource: "mcp_roots",
                routeledgerRoot: workspaceRoot,
                workspaceConfigPath: getDefaultWorkspaceConfigPath(workspaceRoot),
                dataRoot: workspaceRoot
              }
            }
          }
        }
      });

      const initResponse = await callTool(server, "init-project-fresh-rooturi", "init_project", {
        name: "Fresh RootUri Workspace",
        expectedRouteLedgerRoot: workspaceRoot
      });
      expect(
        getStructuredData<{
          project: { name: string };
        }>(initResponse)
      ).toMatchObject({
        project: {
          name: "Fresh RootUri Workspace"
        }
      });

      expect(fs.existsSync(getDefaultWorkspaceConfigPath(workspaceRoot))).toBe(true);
      expect(
        fs.readFileSync(getDefaultWorkspaceConfigPath(workspaceRoot), "utf8")
      ).toContain('"dataDir": "."');
      expect(fs.existsSync(path.join(workspaceRoot, ".routeledger", "project.json"))).toBe(true);
    } finally {
      server.close();
      cleanupProjectRoot(workspaceRoot);
    }
  });

});
