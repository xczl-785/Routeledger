import { describe, expect, it } from "vitest";

import { MCP_MRTR_PROTOCOL_VERSION } from "../index.js";
import {
  digestMcpToolArguments,
  sealMcpRequestState,
  verifyMcpRequestState
} from "../mcp-request-state.js";
import { createRouteLedgerStdioServer } from "../stdio-server.js";
import { cleanupProjectRoot, createTempProjectRoot } from "./mcp-test-helpers.js";

const SECRET = "routeledger-mrtr-test-secret-32-characters";
const meta = {
  "io.modelcontextprotocol/protocolVersion": MCP_MRTR_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "stdio-conformance", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } }
};

const call = (
  server: ReturnType<typeof createRouteLedgerStdioServer>,
  id: string,
  name: string,
  args: Record<string, unknown>,
  retry?: { requestState: string; inputResponses: Record<string, unknown> }
) =>
  server.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: meta,
      ...(retry ?? {})
    }
  });

const structured = (response: unknown) =>
  (response as { result: { structuredContent: Record<string, unknown> } }).result
    .structuredContent;

describe("MCP 2026-07-28 multi round-trip conformance", () => {
  it("discovers both protocol eras without requiring a legacy initialize handshake", async () => {
    const root = createTempProjectRoot();
    const server = createRouteLedgerStdioServer({ workspaceRoot: root, routeledgerRoot: root });
    try {
      const response = await server.handleMessage({
        jsonrpc: "2.0",
        id: "discover",
        method: "server/discover",
        params: { _meta: meta }
      });
      expect(response).toMatchObject({
        result: {
          resultType: "complete",
          supportedVersions: [MCP_MRTR_PROTOCOL_VERSION, "2025-11-25"],
          capabilities: { tools: { listChanged: false } }
        }
      });
    } finally {
      server.close();
      cleanupProjectRoot(root);
    }
  });

  it("returns native input_required and resumes the exact proposal after a server restart", async () => {
    const root = createTempProjectRoot();
    let server = createRouteLedgerStdioServer({
      workspaceRoot: root,
      routeledgerRoot: root,
      mcpRequestStateSecret: SECRET
    });
    try {
      const initialized = await call(server, "init", "init_project", {
        name: "MRTR conformance",
        contentLocale: "en",
        firstVersion: { title: "Initial", description: "MRTR target", initialTodos: [] },
        expectedRouteLedgerRoot: root
      });
      const initData = structured(initialized);
      const projectId = (initData.data as { project: { id: string } }).project.id;
      const versionId = (initData.data as { firstVersion: { id: string } }).firstVersion.id;
      await call(server, "prepare", "prepare_version", {
        projectId,
        versionId,
        expectedRouteLedgerRoot: root
      });
      const args = {
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "MRTR exact proposal",
        idempotencyKey: "mrtr-start",
        expectedRouteLedgerRoot: root
      };
      const first = await call(server, "execute-1", "execute_l3_operation", args);
      expect(first).toMatchObject({
        result: {
          resultType: "input_required",
          inputRequests: {
            routeledger_l3_decision: {
              method: "elicitation/create",
              params: { mode: "form" }
            }
          }
        }
      });
      const requestState = (first as { result: { requestState: string } }).result.requestState;

      server.close();
      server = createRouteLedgerStdioServer({
        workspaceRoot: root,
        routeledgerRoot: root,
        mcpRequestStateSecret: SECRET
      });
      const resumed = await call(server, "execute-2", "execute_l3_operation", args, {
        requestState,
        inputResponses: {
          routeledger_l3_decision: {
            action: "accept",
            content: { approve: true }
          }
        }
      });
      expect(resumed).toMatchObject({
        result: {
          resultType: "complete",
          structuredContent: {
            ok: true,
            data: { status: "committed", proposalId: expect.any(String) }
          }
        }
      });
      const duplicateRetry = await call(server, "execute-3", "execute_l3_operation", args, {
        requestState,
        inputResponses: {
          routeledger_l3_decision: {
            action: "accept",
            content: { approve: true }
          }
        }
      });
      expect(duplicateRetry).toMatchObject({
        result: {
          resultType: "complete",
          structuredContent: {
            ok: true,
            data: { status: "committed", commit: { replayed: true } }
          }
        }
      });
      const proposals = await call(server, "list", "list_l3_proposals", { projectId });
      expect((structured(proposals).data as unknown[])).toHaveLength(1);
    } finally {
      server.close();
      cleanupProjectRoot(root);
    }
  });

  it("rejects tampered, mismatched, and response-only retries before consuming authorization", async () => {
    const root = createTempProjectRoot();
    const server = createRouteLedgerStdioServer({
      workspaceRoot: root,
      routeledgerRoot: root,
      mcpRequestStateSecret: SECRET
    });
    try {
      const initialized = await call(server, "init", "init_project", {
        name: "MRTR tamper",
        contentLocale: "en",
        firstVersion: { title: "Initial", description: "MRTR target", initialTodos: [] },
        expectedRouteLedgerRoot: root
      });
      const initData = structured(initialized);
      const projectId = (initData.data as { project: { id: string } }).project.id;
      const versionId = (initData.data as { firstVersion: { id: string } }).firstVersion.id;
      await call(server, "prepare", "prepare_version", {
        projectId,
        versionId,
        expectedRouteLedgerRoot: root
      });
      const args = {
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "MRTR tamper",
        idempotencyKey: "mrtr-tamper",
        expectedRouteLedgerRoot: root
      };
      const first = await call(server, "execute-1", "execute_l3_operation", args);
      const state = (first as { result: { requestState: string } }).result.requestState;
      const decision = {
        routeledger_l3_decision: {
          action: "accept",
          content: { approve: true }
        }
      };
      const tampered = await call(server, "execute-2", "execute_l3_operation", args, {
        requestState: `${state.slice(0, -1)}x`,
        inputResponses: decision
      });
      expect(tampered).toMatchObject({ error: { code: -32602 } });
      const mismatched = await call(
        server,
        "execute-3",
        "execute_l3_operation",
        { ...args, reason: "different request" },
        { requestState: state, inputResponses: decision }
      );
      expect(mismatched).toMatchObject({ error: { code: -32602 } });
      const decoded = verifyMcpRequestState(state, SECRET, {
        toolName: "execute_l3_operation",
        argumentsDigest: digestMcpToolArguments(args)
      });
      const staleLiveBinding = sealMcpRequestState(
        {
          ...decoded,
          binding: { ...decoded.binding, operationDigest: "stale-live-digest" }
        },
        SECRET
      );
      const stale = await call(server, "execute-stale", "execute_l3_operation", args, {
        requestState: staleLiveBinding,
        inputResponses: decision
      });
      expect(stale).toMatchObject({
        result: {
          structuredContent: {
            ok: false,
            error: { code: "INVALID_TOOL_INPUT" }
          }
        }
      });
      const responseOnly = await server.handleMessage({
        jsonrpc: "2.0",
        id: "execute-4",
        method: "tools/call",
        params: {
          name: "execute_l3_operation",
          arguments: args,
          _meta: meta,
          inputResponses: decision
        }
      });
      expect(responseOnly).toMatchObject({ error: { code: -32602 } });
      const proposals = await call(server, "list", "list_l3_proposals", { projectId });
      expect((structured(proposals).data as Array<{ status: string }>)).toMatchObject([
        { status: "pending" }
      ]);
    } finally {
      server.close();
      cleanupProjectRoot(root);
    }
  });

  it("requires explicit request-state configuration before creating a 2026 L3 proposal", async () => {
    const root = createTempProjectRoot();
    const server = createRouteLedgerStdioServer({ workspaceRoot: root, routeledgerRoot: root });
    try {
      const initialized = await call(server, "init", "init_project", {
        name: "MRTR config gate",
        contentLocale: "en",
        firstVersion: { title: "Initial", description: "MRTR target", initialTodos: [] },
        expectedRouteLedgerRoot: root
      });
      const initData = structured(initialized);
      const projectId = (initData.data as { project: { id: string } }).project.id;
      const versionId = (initData.data as { firstVersion: { id: string } }).firstVersion.id;
      await call(server, "prepare", "prepare_version", {
        projectId,
        versionId,
        expectedRouteLedgerRoot: root
      });
      const blocked = await call(server, "execute", "execute_l3_operation", {
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "Must fail before proposal",
        idempotencyKey: "missing-secret",
        expectedRouteLedgerRoot: root
      });
      expect(blocked).toMatchObject({
        result: {
          resultType: "complete",
          structuredContent: {
            ok: false,
            error: { code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE" }
          }
        }
      });
      const proposals = await call(server, "list", "list_l3_proposals", { projectId });
      expect(structured(proposals).data).toEqual([]);
    } finally {
      server.close();
      cleanupProjectRoot(root);
    }
  });
});
