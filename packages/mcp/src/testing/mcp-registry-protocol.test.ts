import { expect, it, describe } from "vitest";

import { MCP_PROTOCOL_VERSION, createRouteLedgerMcpRegistry } from "../index.js";
import { createRouteLedgerStdioServer, type JsonRpcResponse } from "../stdio-server.js";

import { createTempProjectRoot, createRegistry, createServer, cleanupProjectRoot, readDebugLogRecords, initializeServer, callTool, getStructuredData, runTranscript, type ToolListResult } from "./mcp-test-helpers.js";
describe("routeledger mcp registry", () => {
  it("init_project requires a concrete contentLocale and localizes human-readable errors", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot
    });

    try {
      const missing = await registry.invoke("configure_project", {
        operation: "initialize",
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot,
        responseLocale: "zh-CN"
      });
      const automatic = await registry.invoke("configure_project", {
        operation: "initialize",
        name: "RouteLedger",
        contentLocale: "auto",
        expectedRouteLedgerRoot: projectRoot,
        responseLocale: "zh-CN"
      });

      expect(missing).toMatchObject({
        ok: false,
        error: {
          code: "CONTENT_LOCALE_REQUIRED",
          message: "项目的 content_locale 尚未确认；请先与用户确认具体语言。"
        }
      });
      expect(automatic).toMatchObject({
        ok: false,
        error: {
          code: "CONTENT_LOCALE_MUST_BE_CONCRETE",
          message: "content_locale 必须是具体语言，不能使用 auto。"
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("init_project without firstVersion creates an initialized empty route", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot
    });

    try {
      const initialized = await registry.invoke("configure_project", {
        operation: "initialize",
        name: "Empty Route",
        contentLocale: "zh-CN",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initialized).toMatchObject({
        ok: true,
        data: {
          project: { currentVersionId: null, initialVersionId: null },
          firstVersion: null,
          todos: []
        }
      });

      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const context = await registry.invoke("inspect_route_progress", {
        operation: "get_current_context",
        projectId
      });
      expect(context).toMatchObject({
        ok: true,
        data: {
          currentVersion: null,
          versions: [],
          nextAction: { actionType: "create_version" }
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("tools/list uses standard annotations and host policy metadata", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot);
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "tools-list",
        method: "tools/list",
        params: {}
      })) as JsonRpcResponse;

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: "tools-list",
        result: {
          tools: expect.any(Array)
        }
      });

      const tools = (response as ToolListResult).result.tools;
      const readOnlyTools = tools.filter(
        (tool) => tool._meta.routeledger.riskLevel === "read-only"
      );
      const writeTools = tools.filter((tool) => tool._meta.routeledger.riskLevel === "write");
      const highRiskTools = tools.filter(
        (tool) => tool._meta.routeledger.riskLevel === "high-risk"
      );
      const expectedToolNames = [
        "inspect_runtime",
        "configure_binding",
        "configure_project",
        "inspect_route_progress",
        "inspect_versions",
        "inspect_l3_route_operations",
        "manage_todo",
        "manage_deferred",
        "manage_constraint",
        "propose_version_lifecycle_change",
        "propose_version_structure_change",
        "propose_l3_route_change",
        "set_version_state",
        "execute_route_change",
        "manage_mission_control"
      ];
      expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);
      expect(tools).toHaveLength(15);
      expect(readOnlyTools.map((tool) => tool.name)).toEqual([
        "inspect_runtime",
        "inspect_route_progress",
        "inspect_versions",
        "inspect_l3_route_operations"
      ]);
      expect(writeTools).toHaveLength(10);
      expect(highRiskTools.map((tool) => tool.name)).toEqual(["execute_route_change"]);

      for (const tool of [...writeTools, ...highRiskTools]) {
        expect(tool.inputSchema.properties).toHaveProperty("expectedRouteLedgerRoot");
        expect(tool.inputSchema.required ?? []).not.toContain("expectedRouteLedgerRoot");
      }
      for (const tool of readOnlyTools) {
        expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("expectedRouteLedgerRoot");
      }
      const executeRouteChange = tools.find((tool) => tool.name === "execute_route_change");
      expect(executeRouteChange?.annotations.destructiveHint).toBe(true);
      expect(executeRouteChange?._meta.routeledger).toMatchObject({
        riskLevel: "high-risk",
        highRisk: true,
        destructive: true,
        recommendedApprovalMode: "approve"
      });
      expect(
        tools
          .filter((tool) => tool.annotations.destructiveHint)
          .map((tool) => tool.name)
          .sort()
      ).toEqual(
        [
          "manage_todo",
          "manage_deferred",
          "manage_constraint",
          "set_version_state",
          "execute_route_change"
        ].sort()
      );

      for (const legacyName of [
        "get_runtime_context",
        "create_todo",
        "prepare_version",
        "execute_l3_operation"
      ]) {
        expect(tools.find((tool) => tool.name === legacyName)).toBeUndefined();
      }

      for (const tool of tools.filter(
        (item) => !["configure_binding", "propose_l3_route_change"].includes(item.name)
      )) {
        const branches = (
          tool.inputSchema as unknown as {
            oneOf?: Array<{
              properties?: { operation?: { const?: string } };
              required?: string[];
            }>;
          }
        ).oneOf;
        expect(branches, tool.name).toBeDefined();
        expect(branches?.every((branch) => branch.required?.includes("operation"))).toBe(true);
        expect(
          branches?.every(
            (branch) => typeof branch.properties?.operation?.const === "string"
          )
        ).toBe(true);
      }

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("tools/call validates inputSchema at the MCP boundary as tool-level errors", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot, { runtimeProfile: "json-only" });
      const badDecisionRefResponse = await callTool(
        server,
        "bad-decision-ref",
        "execute_route_change",
        {
          operation: "approve_l3_operation",
          projectId: "missing-project",
          pendingOperationId: "pending-operation",
          decisionRef: 42
        }
      );
      const extraFieldResponse = await callTool(
        server,
        "extra-field",
        "configure_project",
        {
          operation: "initialize",
          name: "RouteLedger",
          unexpected: true
        }
      );
      const missingRequiredResponse = await callTool(
        server,
        "missing-required",
        "inspect_versions",
        { operation: "list_versions" }
      );
      const runtimeContext = getStructuredData<{
        activeProject: { id: string; name: string } | null;
      }>(
        await callTool(server, "schema-validation-context", "inspect_runtime", {
          operation: "runtime"
        })
      );

      expect(runtimeContext.activeProject).toBeNull();

      expect(badDecisionRefResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "bad-decision-ref",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.decisionRef"
              }
            },
            meta: {
              runtimeContext: {
                projectId: null,
                projectName: null,
                activeProject: null
              }
            }
          }
        }
      });
      expect(
        (
          badDecisionRefResponse as {
            result: {
              structuredContent: {
                error: {
                  details: {
                    issues: Array<{ path: string; message: string }>;
                  };
                };
              };
            };
          }
        ).result.structuredContent.error.details.issues
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.any(String),
            message: expect.any(String)
          })
        ])
      );
      expect(extraFieldResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "extra-field",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.contentLocale"
              }
            }
          }
        }
      });
      expect(missingRequiredResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "missing-required",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              details: {
                path: "$.projectId"
              }
            }
          }
        }
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("tools/call names unexpected write-binding fields on read tools", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot, { runtimeProfile: "json-only" });
      const response = await callTool(
        server,
        "read-tool-unexpected-binding-field",
        "inspect_runtime",
        {
          operation: "runtime",
          expectedRouteLedgerRoot: projectRoot
        }
      );

      expect(response).toMatchObject({
        jsonrpc: "2.0",
        id: "read-tool-unexpected-binding-field",
        result: {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: "INVALID_TOOL_INPUT",
              message: expect.stringContaining("expectedRouteLedgerRoot"),
              details: {
                path: "$.expectedRouteLedgerRoot"
              }
            }
          }
        }
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("registry error envelopes derive active project metadata from inspected runtime state", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      runtimeProfile: "json-only"
    });

    try {
      const initialized = await registry.invoke("configure_project", {
        operation: "initialize",
        name: "Inspected Runtime Project",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      const project = (initialized.data as { project: { id: string; name: string } }).project;
      const expectedRuntimeContext = {
        projectId: project.id,
        projectName: project.name,
        activeProject: expect.objectContaining({
          id: project.id,
          name: project.name,
          source: "canonical_json"
        })
      };

      const preflightError = await registry.invoke("manage_todo", {
        operation: "create",
        projectId: "untrusted-request-project",
        versionId: "untrusted-request-version",
        title: "must not write",
        idempotencyKey: "untrusted-request-create"
      });
      const applicationError = await registry.invoke("inspect_versions", {
        operation: "list_versions",
        projectId: "untrusted-request-project"
      });
      const inputError = await registry.invoke("inspect_route_progress", {
        operation: "get_current_context",
        projectId: 42
      } as any);
      const unknownToolError = await registry.invoke("not_a_routeledger_tool", {
        projectId: "untrusted-request-project"
      });

      for (const response of [
        preflightError,
        applicationError,
        inputError,
        unknownToolError
      ]) {
        expect(response).toMatchObject({
          ok: false,
          meta: { runtimeContext: expectedRuntimeContext }
        });
      }
      expect(preflightError.error?.code).toBe("ROUTELEDGER_WRITE_BINDING_ASSERTION_REQUIRED");
      expect(applicationError.error?.code).toBe("PROJECT_NOT_FOUND");
      expect(inputError.error?.code).toBe("INVALID_TOOL_INPUT");
      expect(unknownToolError.error?.code).toBe("ACTION_NOT_IMPLEMENTED");
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("tools/call unknown tool remains a JSON-RPC boundary error without runtime metadata", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = await initializeServer(projectRoot, { runtimeProfile: "json-only" });
      const response = await server.handleMessage({
        jsonrpc: "2.0",
        id: "unknown-tool",
        method: "tools/call",
        params: {
          name: "not_a_routeledger_tool",
          arguments: { projectId: "untrusted-request-project" }
        }
      });

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: "unknown-tool",
        error: {
          code: -32602,
          message: "Unknown tool 'not_a_routeledger_tool'."
        }
      });
      expect(JSON.stringify(response)).not.toContain("runtimeContext");

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("debug log is disabled by default and writes structured JSONL only when enabled", async () => {
    const defaultProjectRoot = createTempProjectRoot();
    const enabledProjectRoot = createTempProjectRoot();
    const defaultRegistry = createRegistry(defaultProjectRoot);
    const enabledRegistry = createRegistry(enabledProjectRoot, {
      hostProfile: "codex",
      actor: {
        id: "debug-agent",
        displayName: "Debug Agent"
      },
      debugLog: {
        enabled: true
      }
    });

    try {
      const defaultInitResponse = await defaultRegistry.invoke("configure_project", {
        operation: "initialize",
        name: "RouteLedger",
        contentLocale: "en",
        firstVersion: { title: "Initial Version", initialTodos: [] },
        expectedRouteLedgerRoot: defaultProjectRoot
      });
      expect(defaultInitResponse.ok).toBe(true);
      const defaultProjectId = (defaultInitResponse.data as {
        project: { id: string };
        firstVersion: { id: string };
      }).project.id;
      const defaultVersionId = (defaultInitResponse.data as {
        project: { id: string };
        firstVersion: { id: string };
      }).firstVersion!.id;

      const defaultGateResponse = await defaultRegistry.invoke("inspect_versions", {
        operation: "check_start_gate",
        projectId: defaultProjectId,
        versionId: defaultVersionId
      });
      expect(defaultGateResponse.ok).toBe(true);
      expect(readDebugLogRecords(defaultProjectRoot)).toEqual([]);

      const enabledInitResponse = await enabledRegistry.invoke("configure_project", {
        operation: "initialize",
        name: "RouteLedger",
        contentLocale: "en",
        firstVersion: { title: "Initial Version", initialTodos: [] },
        expectedRouteLedgerRoot: enabledProjectRoot
      });
      expect(enabledInitResponse.ok).toBe(true);
      const enabledData = enabledInitResponse.data as {
        project: { id: string };
        firstVersion: { id: string };
      };

      const enabledGateResponse = await enabledRegistry.invoke("inspect_versions", {
        operation: "check_start_gate",
        projectId: enabledData.project.id,
        versionId: enabledData.firstVersion!.id
      });
      expect(enabledGateResponse.ok).toBe(true);
      const failureResponse = await enabledRegistry.invoke("inspect_route_progress", {
        operation: "get_current_context",
        projectId: "missing-project"
      });
      expect(failureResponse.ok).toBe(false);

      expect(readDebugLogRecords(enabledProjectRoot)).toEqual([
        expect.objectContaining({
          type: "gate.start",
          toolName: "check_start_gate",
          projectId: enabledData.project.id,
          versionId: enabledData.firstVersion!.id,
          actorId: "debug-agent",
          actorDisplayName: "Debug Agent",
          hostProfile: "codex",
          payload: expect.objectContaining({
            allowed: expect.any(Boolean),
            blockerCodes: expect.any(Array)
          })
        }),
        expect.objectContaining({
          type: "tool.failure",
          toolName: "inspect_route_progress",
          projectId: "missing-project",
          actorId: "debug-agent",
          actorDisplayName: "Debug Agent",
          hostProfile: "codex",
          payload: expect.objectContaining({
            error: expect.objectContaining({
              code: expect.any(String),
              message: expect.any(String)
            }),
            inputKeys: ["operation", "projectId"]
          })
        })
      ]);
    } finally {
      defaultRegistry.close();
      enabledRegistry.close();
      cleanupProjectRoot(defaultProjectRoot);
      cleanupProjectRoot(enabledProjectRoot);
    }
  });

  it("tools/call uses params.arguments and returns structured success content", async () => {
    const projectRoot = createTempProjectRoot();
    let server: ReturnType<typeof createRouteLedgerStdioServer> | null = null;

    try {
      server = await initializeServer(projectRoot);
      const initResponse = await callTool(
        server,
        "init-project",
        "configure_project",
        {
          operation: "initialize",
          name: "RouteLedger",
          contentLocale: "en",
          firstVersion: { title: "Initial Version", initialTodos: [] }
        }
      );

      expect(initResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "init-project",
        result: {
          structuredContent: {
            ok: true
          },
          content: [
            {
              type: "text"
            }
          ]
        }
      });

      const projectId = (
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
      ).result.structuredContent.data.project.id;
      const contextResponse = await callTool(
        server,
        "get-context",
        "inspect_route_progress",
        {
          operation: "get_current_context",
          projectId
        }
      );
      const nextActionResponse = await callTool(server, "next-action", "inspect_route_progress", {
        operation: "next_action",
        projectId
      });
      const summarizeVersionCloseoutResponse = await callTool(
        server,
        "summarize-closeout",
        "inspect_route_progress",
        {
          operation: "summarize_version_closeout",
          projectId
        }
      );
      const planVersionCloseoutResponse = await callTool(
        server,
        "plan-closeout",
        "inspect_route_progress",
        {
          operation: "plan_version_closeout",
          projectId
        }
      );
      const listVersionsWindowResponse = await callTool(
        server,
        "list-versions-window",
        "inspect_versions",
        {
          operation: "list_versions_window",
          projectId
        }
      );

      expect(contextResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "get-context",
        result: {
          structuredContent: {
            ok: true,
            data: {
              project: {
                id: projectId
              }
            },
            meta: {
              budgetBytes: expect.any(Number),
              versionWindow: {
                aroundVersionId: expect.any(String),
                totalCount: 1,
                includedCount: 1,
                omittedBeforeCount: 0,
                omittedAfterCount: 0,
                before: 3,
                after: 3,
                includeAllVersions: false
              },
              runtimeContext: {
                projectId,
                projectName: "RouteLedger",
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                }
              }
            }
          }
        }
      });
      expect(nextActionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "next-action",
        result: {
          structuredContent: {
            ok: true,
            data: {
              project: {
                id: projectId
              },
              nextAction: {
                actionType: "prepare_version"
              },
              statusRisks: expect.any(Array)
            },
            meta: {
              runtimeContext: {
                projectId,
                projectName: "RouteLedger",
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                }
              }
            }
          }
        }
      });
      expect(summarizeVersionCloseoutResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "summarize-closeout",
        result: {
          structuredContent: {
            ok: true,
            data: {
              projectId,
              version: {
                id: expect.any(String),
                state: "wait",
                isCurrent: true
              },
              closeGate: {
                ok: false
              },
              nextAction: {
                actionType: "none"
              }
            },
            meta: {
              eventLimit: 10,
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              },
              runtimeContext: {
                projectId,
                projectName: null,
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                }
              }
            }
          }
        }
      });
      expect(planVersionCloseoutResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "plan-closeout",
        result: {
          structuredContent: {
            ok: true,
            data: {
              projectId,
              status: "planned",
              summary: {
                canClose: false,
                version: {
                  state: "wait"
                }
              },
              steps: [expect.objectContaining({ kind: "no_op" })]
            },
            meta: {
              eventLimit: 10,
              metadata: {
                workflowMode: "read_only",
                createsPendingProposal: false
              },
              runtimeContext: {
                projectId,
                projectName: null,
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                }
              }
            }
          }
        }
      });
      expect(listVersionsWindowResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "list-versions-window",
        result: {
          structuredContent: {
            ok: true,
            data: {
              project: {
                id: projectId
              },
              aroundVersionId: expect.any(String),
              versions: expect.any(Array)
            },
            meta: {
              versionWindow: {
                totalCount: 1,
                includedCount: 1,
                omittedBeforeCount: 0,
                omittedAfterCount: 0
              },
              runtimeContext: {
                projectId,
                projectName: "RouteLedger",
                hostProfile: "codex",
                binding: {
                  workspaceRoot: projectRoot,
                  routeledgerRoot: projectRoot
                }
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

  it("protocol errors cover invalid params and unknown methods", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const server = createRouteLedgerStdioServer({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot
      });
      const beforeInitResponse = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "too-early",
        method: "tools/list",
        params: {}
      })) as JsonRpcResponse;

      expect(beforeInitResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "too-early",
        error: {
          code: -32002
        }
      });

      const initializeResponse = await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      });
      const initializedResponse = await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      expect(initializeResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize",
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION
        }
      });
      expect(initializedResponse).toBeNull();

      const invalidParamsResponse = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "bad-call",
        method: "tools/call",
        params: {
          name: "inspect_route_progress",
          arguments: "nope"
        }
      })) as JsonRpcResponse;
      const unknownMethodResponse = (await server.handleMessage({
        jsonrpc: "2.0",
        id: "unknown-method",
        method: "tools/mutate",
        params: {}
      })) as JsonRpcResponse;

      expect(invalidParamsResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "bad-call",
        error: {
          code: -32602
        }
      });
      expect(unknownMethodResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "unknown-method",
        error: {
          code: -32601
        }
      });

      server.close();
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

  it("initialize requires capabilities and clientInfo.version", async () => {
    const missingCapabilitiesRoot = createTempProjectRoot();
    const missingVersionRoot = createTempProjectRoot();

    try {
      const missingCapabilitiesServer = createServer(missingCapabilitiesRoot);
      const missingVersionServer = createServer(missingVersionRoot);

      const missingCapabilitiesResponse = (await missingCapabilitiesServer.handleMessage({
        jsonrpc: "2.0",
        id: "missing-capabilities",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          clientInfo: {
            name: "vitest",
            version: "0.0.0"
          }
        }
      })) as JsonRpcResponse;
      const missingVersionResponse = (await missingVersionServer.handleMessage({
        jsonrpc: "2.0",
        id: "missing-version",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "vitest"
          }
        }
      })) as JsonRpcResponse;

      expect(missingCapabilitiesResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "missing-capabilities",
        error: {
          code: -32602,
          message: expect.stringContaining("capabilities")
        }
      });
      expect(missingVersionResponse).toMatchObject({
        jsonrpc: "2.0",
        id: "missing-version",
        error: {
          code: -32602,
          message: expect.stringContaining("version")
        }
      });

      missingCapabilitiesServer.close();
      missingVersionServer.close();
    } finally {
      cleanupProjectRoot(missingCapabilitiesRoot);
      cleanupProjectRoot(missingVersionRoot);
    }
  });

  it("runRouteLedgerStdioServer emits parse errors and skips initialized notifications", async () => {
    const projectRoot = createTempProjectRoot();

    try {
      const { responses, stderr } = await runTranscript(projectRoot, [
        "{not-json",
        JSON.stringify({
          jsonrpc: "2.0",
          id: "initialize",
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "vitest",
              version: "0.0.0"
            }
          }
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: "tools-list",
          method: "tools/list",
          params: {}
        })
      ]);

      expect(stderr).toBe("");
      expect(responses).toHaveLength(3);
      expect(responses[0]).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700
        }
      });
      expect(responses[1]).toMatchObject({
        jsonrpc: "2.0",
        id: "initialize",
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION
        }
      });
      expect(responses[2]).toMatchObject({
        jsonrpc: "2.0",
        id: "tools-list",
        result: {
          tools: expect.any(Array)
        }
      });
    } finally {
      cleanupProjectRoot(projectRoot);
    }
  });

});
