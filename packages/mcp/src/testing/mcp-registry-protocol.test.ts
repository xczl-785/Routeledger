import { expect, it, describe } from "vitest";

import { MCP_PROTOCOL_VERSION, createRouteLedgerMcpRegistry } from "../index.js";
import { createRouteLedgerStdioServer, type JsonRpcResponse } from "../stdio-server.js";

import { createTempProjectRoot, getDefaultCanonicalJsonRoot, getDefaultSqliteDbPath, createRegistry, createServer, cleanupProjectRoot, readDebugLogRecords, initializeServer, callTool, getStructuredData, runTranscript, type ToolListResult } from "./mcp-test-helpers.js";
describe("routeledger mcp registry", () => {
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
      expect(tools).toHaveLength(42);
      const runtimeContextTool = tools.find((tool) => tool.name === "get_runtime_context");
      const openMissionControlTool = tools.find((tool) => tool.name === "open_mission_control");
      const writeHostBindingConfigTool = tools.find(
        (tool) => tool.name === "write_host_binding_config"
      );
      const missionControlStatusTool = tools.find(
        (tool) => tool.name === "get_mission_control_status"
      );
      const contextTool = tools.find((tool) => tool.name === "get_current_context");
      const nextActionTool = tools.find((tool) => tool.name === "next_action");
      const checkDocDriftTool = tools.find((tool) => tool.name === "check_doc_drift");
      const summarizeVersionCloseoutTool = tools.find(
        (tool) => tool.name === "summarize_version_closeout"
      );
      const planVersionCloseoutTool = tools.find((tool) => tool.name === "plan_version_closeout");
      const listVersionsWindowTool = tools.find((tool) => tool.name === "list_versions_window");
      const getVersionStructureTool = tools.find((tool) => tool.name === "get_version_structure");
      const getVersionTransitionGuideTool = tools.find(
        (tool) => tool.name === "get_version_transition_guide"
      );
      const transitionVersionTool = tools.find((tool) => tool.name === "transition_version");
      const closeVersionTool = tools.find((tool) => tool.name === "close_version");
      const shutdownVersionTool = tools.find((tool) => tool.name === "shutdown_version");
      const carryForwardUndoTool = tools.find((tool) => tool.name === "carry_forward_undo");
      const approveTool = tools.find((tool) => tool.name === "approve_l3_operation");
      const rejectTool = tools.find((tool) => tool.name === "reject_l3_operation");
      const commitTool = tools.find((tool) => tool.name === "commit_l3_operation");
      const createVersionTool = tools.find((tool) => tool.name === "create_version");
      const insertVersionTool = tools.find((tool) => tool.name === "insert_version");
      const createChildVersionTool = tools.find((tool) => tool.name === "create_child_version");
      const reorderVersionsTool = tools.find((tool) => tool.name === "reorder_versions");

      expect(runtimeContextTool?.annotations.readOnlyHint).toBe(true);
      expect(runtimeContextTool?.annotations.idempotentHint).toBe(true);
      expect(runtimeContextTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(runtimeContextTool?._meta.routeledger.recommendedApprovalMode).toBe("auto");
      expect(openMissionControlTool?.annotations.readOnlyHint).toBe(true);
      expect(openMissionControlTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(openMissionControlTool?.inputSchema.properties).toMatchObject({
        workspaceRoot: expect.objectContaining({ type: "string" }),
        routeledgerRoot: expect.objectContaining({ type: "string" }),
        devBuild: expect.objectContaining({ type: "boolean" })
      });
      expect(missionControlStatusTool?.annotations.readOnlyHint).toBe(true);
      expect(missionControlStatusTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(missionControlStatusTool?.inputSchema.properties).toMatchObject({
        workspaceRoot: expect.objectContaining({ type: "string" }),
        routeledgerRoot: expect.objectContaining({ type: "string" })
      });
      expect(contextTool?.annotations.readOnlyHint).toBe(true);
      expect(contextTool?.annotations.idempotentHint).toBe(true);
      expect(writeHostBindingConfigTool?.annotations.readOnlyHint).toBe(false);
      expect(writeHostBindingConfigTool?._meta.routeledger).toMatchObject({
        riskLevel: "write",
        recommendedApprovalMode: "prompt"
      });
      expect(writeHostBindingConfigTool?.inputSchema.properties).toMatchObject({
        routeledgerRoot: expect.objectContaining({ type: "string" }),
        outputPath: expect.objectContaining({ type: "string" }),
        expectedRouteLedgerRoot: expect.objectContaining({ type: "string" })
      });
      expect(writeTools).toHaveLength(19);
      expect(highRiskTools).toHaveLength(4);
      for (const tool of [...writeTools, ...highRiskTools]) {
        expect(tool.inputSchema.properties).toHaveProperty("expectedRouteLedgerRoot");
        expect(tool.inputSchema.required ?? []).not.toContain("expectedRouteLedgerRoot");
      }
      for (const tool of readOnlyTools) {
        expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("expectedRouteLedgerRoot");
      }
      expect(nextActionTool?.annotations.readOnlyHint).toBe(true);
      expect(nextActionTool?.annotations.idempotentHint).toBe(true);
      expect(checkDocDriftTool?.annotations.readOnlyHint).toBe(true);
      expect(checkDocDriftTool?.annotations.idempotentHint).toBe(true);
      expect(checkDocDriftTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(checkDocDriftTool?.description).toBe(
        "Compare selected entry docs with RouteLedger truth. Input: entryFiles."
      );
      expect(summarizeVersionCloseoutTool?.annotations.readOnlyHint).toBe(true);
      expect(summarizeVersionCloseoutTool?.annotations.idempotentHint).toBe(true);
      expect(summarizeVersionCloseoutTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(summarizeVersionCloseoutTool?.description).toBe(
        "Summarize a version's closeout blockers and evidence."
      );
      expect(planVersionCloseoutTool?.annotations.readOnlyHint).toBe(true);
      expect(planVersionCloseoutTool?.annotations.idempotentHint).toBe(true);
      expect(planVersionCloseoutTool?._meta.routeledger.riskLevel).toBe("read-only");
      expect(planVersionCloseoutTool?.description).toBe(
        "Plan concrete steps to clear a version closeout."
      );
      expect(listVersionsWindowTool?.annotations.readOnlyHint).toBe(true);
      expect(listVersionsWindowTool?.annotations.idempotentHint).toBe(true);
      expect(getVersionStructureTool?.annotations.readOnlyHint).toBe(true);
      expect(getVersionStructureTool?.annotations.idempotentHint).toBe(true);
      expect(getVersionTransitionGuideTool?.annotations.readOnlyHint).toBe(true);
      expect(getVersionTransitionGuideTool?.annotations.idempotentHint).toBe(true);
      expect(transitionVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(closeVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(shutdownVersionTool?._meta.routeledger.riskLevel).toBe("high-risk");
      expect(carryForwardUndoTool).toBeUndefined();
      for (const legacyToolName of [
        "create_undo",
        "reassign_undo",
        "carry_forward_undo",
        "resolve_undo_as_downstream_input",
        "close_undo"
      ]) {
        expect(tools.find((tool) => tool.name === legacyToolName)).toBeUndefined();
      }
      expect(approveTool?._meta.routeledger).toMatchObject({
        riskLevel: "high-risk",
        highRisk: true,
        destructive: false,
        recommendedApprovalMode: "prompt"
      });
      expect(rejectTool?._meta.routeledger).toMatchObject({
        riskLevel: "high-risk",
        highRisk: true,
        destructive: false,
        recommendedApprovalMode: "prompt"
      });
      expect(commitTool?.annotations.destructiveHint).toBe(true);
      expect(commitTool?._meta.routeledger).toMatchObject({
        destructive: true,
        recommendedApprovalMode: "approve"
      });
      expect(createVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(insertVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(createChildVersionTool?._meta.routeledger.riskLevel).toBe("write");
      expect(reorderVersionsTool?._meta.routeledger.riskLevel).toBe("write");

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
        "approve_l3_operation",
        {
          projectId: "missing-project",
          pendingOperationId: "pending-operation",
          decisionRef: 42
        }
      );
      const extraFieldResponse = await callTool(server, "extra-field", "init_project", {
        name: "RouteLedger",
        unexpected: true
      });
      const missingRequiredResponse = await callTool(
        server,
        "missing-required",
        "list_versions",
        {}
      );
      const runtimeContext = getStructuredData<{
        activeProject: { id: string; name: string } | null;
      }>(await callTool(server, "schema-validation-context", "get_runtime_context", {}));

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
            path: "$.decisionRef",
            message: expect.stringContaining("Expected string")
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
                path: "$.unexpected"
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

  it("registry error envelopes derive active project metadata from inspected runtime state", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      runtimeProfile: "json-only"
    });

    try {
      const initialized = await registry.invoke("init_project", {
        name: "Inspected Runtime Project",
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

      const preflightError = await registry.invoke("create_todo", {
        projectId: "untrusted-request-project",
        versionId: "untrusted-request-version",
        title: "must not write"
      });
      const applicationError = await registry.invoke("list_versions", {
        projectId: "untrusted-request-project"
      });
      const inputError = await registry.invoke("get_current_context", {
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
      const defaultInitResponse = await defaultRegistry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: defaultProjectRoot
      });
      expect(defaultInitResponse.ok).toBe(true);
      const defaultProjectId = (defaultInitResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      }).project.id;
      const defaultVersionId = (defaultInitResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      }).initialVersion.id;

      const defaultGateResponse = await defaultRegistry.invoke("check_start_gate", {
        projectId: defaultProjectId,
        versionId: defaultVersionId
      });
      expect(defaultGateResponse.ok).toBe(true);
      expect(readDebugLogRecords(defaultProjectRoot)).toEqual([]);

      const enabledInitResponse = await enabledRegistry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: enabledProjectRoot
      });
      expect(enabledInitResponse.ok).toBe(true);
      const enabledData = enabledInitResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      };

      const enabledGateResponse = await enabledRegistry.invoke("check_start_gate", {
        projectId: enabledData.project.id,
        versionId: enabledData.initialVersion.id
      });
      expect(enabledGateResponse.ok).toBe(true);
      const failureResponse = await enabledRegistry.invoke("get_current_context", {
        projectId: "missing-project"
      });
      expect(failureResponse.ok).toBe(false);

      expect(readDebugLogRecords(enabledProjectRoot)).toEqual([
        expect.objectContaining({
          type: "gate.start",
          toolName: "check_start_gate",
          projectId: enabledData.project.id,
          versionId: enabledData.initialVersion.id,
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
          toolName: "get_current_context",
          projectId: "missing-project",
          actorId: "debug-agent",
          actorDisplayName: "Debug Agent",
          hostProfile: "codex",
          payload: expect.objectContaining({
            error: expect.objectContaining({
              code: expect.any(String),
              message: expect.any(String)
            }),
            inputKeys: ["projectId"]
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
      const initResponse = await callTool(server, "init-project", "init_project", {
        name: "RouteLedger"
      });

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
        "get_current_context",
        {
          projectId
        }
      );
      const nextActionResponse = await callTool(server, "next-action", "next_action", {
        projectId
      });
      const summarizeVersionCloseoutResponse = await callTool(
        server,
        "summarize-closeout",
        "summarize_version_closeout",
        {
          projectId
        }
      );
      const planVersionCloseoutResponse = await callTool(
        server,
        "plan-closeout",
        "plan_version_closeout",
        {
          projectId
        }
      );
      const listVersionsWindowResponse = await callTool(
        server,
        "list-versions-window",
        "list_versions_window",
        {
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
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
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
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
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
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
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
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
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
                },
                routeledgerDir: getDefaultCanonicalJsonRoot(projectRoot),
                sqliteDbPath: getDefaultSqliteDbPath(projectRoot)
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
          name: "get_current_context",
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
