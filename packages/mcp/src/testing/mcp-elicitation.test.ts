import { describe, expect, it } from "vitest";

import { MCP_PROTOCOL_VERSION } from "../index.js";
import { createRouteLedgerStdioServer, type JsonRpcMessage } from "../stdio-server.js";
import { cleanupProjectRoot, createTempProjectRoot } from "./mcp-test-helpers.js";

const call = (
  server: ReturnType<typeof createRouteLedgerStdioServer>,
  id: string,
  name: string,
  args: Record<string, unknown>
) =>
  server.handleMessage({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args }
  });

const structured = (response: unknown) =>
  (response as { result: { structuredContent: { data?: unknown; error?: unknown } } }).result
    .structuredContent;

describe("MCP L3 authorization elicitation", () => {
  it("suspends approval, accepts a client decision, and mints trusted provenance", async () => {
    const projectRoot = createTempProjectRoot();
    const outbound: JsonRpcMessage[] = [];
    const server = createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      hostProfile: "codex",
      approver: { id: "routeledger-user", displayName: "RouteLedger user" },
      sendMessage: (message) => outbound.push(message)
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { elicitation: {} },
          clientInfo: { name: "codex", version: "0.147.0" }
        }
      });
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const initialized = await call(server, "init", "init_project", {
        name: "Authorization Probe",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      if (!(structured(initialized) as { ok: boolean }).ok) {
        throw new Error(JSON.stringify(structured(initialized), null, 2));
      }
      const projectId = (structured(initialized).data as { project: { id: string } }).project.id;
      const createResponse = await call(server, "create", "create_version", {
        projectId,
        title: "Version 1",
        expectedRouteLedgerRoot: projectRoot
      });
      if (!(structured(createResponse).error as { details?: { pendingOperationId?: string } })?.details
        ?.pendingOperationId) {
        throw new Error(JSON.stringify(structured(createResponse), null, 2));
      }
      const pendingOperationId = (
        structured(createResponse).error as { details: { pendingOperationId: string } }
      ).details.pendingOperationId;

      const approvalPromise = call(server, "approve", "approve_l3_operation", {
        projectId,
        pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (outbound.some((message) => "method" in message && message.method === "elicitation/create")) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }

      const elicitation = outbound.find(
        (message) => "method" in message && message.method === "elicitation/create"
      );
      expect(elicitation).toMatchObject({
        jsonrpc: "2.0",
        method: "elicitation/create",
        params: {
          mode: "form",
          requestedSchema: {
            required: ["approve", "scope"]
          }
        }
      });
      expect(JSON.stringify((elicitation as { params: unknown }).params)).toContain(
        pendingOperationId.length > 0 ? "Operation digest" : "never"
      );

      await server.handleMessage({
        jsonrpc: "2.0",
        id: (elicitation as { id: string | number }).id,
        result: {
          action: "accept",
          content: { approve: true, scope: "operation" }
        }
      });
      const approvalResponse = await approvalPromise;

      expect(structured(approvalResponse).data).toMatchObject({
        status: "approved",
        approvalSource: "user_interaction",
        authorizationGrantId: expect.any(String),
        hostKind: "codex",
        clientId: "codex",
        approver: { id: "routeledger-user", type: "user" }
      });
    } finally {
      server.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("fails closed when the client does not advertise elicitation", async () => {
    const projectRoot = createTempProjectRoot();
    const server = createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      hostProfile: "generic"
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "generic-agent", version: "1.0.0" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });

      const initialized = await call(server, "init", "init_project", {
        name: "Authorization Probe",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      const projectId = (structured(initialized).data as { project: { id: string } }).project.id;
      const createResponse = await call(server, "create", "create_version", {
        projectId,
        title: "Version 1",
        expectedRouteLedgerRoot: projectRoot
      });
      const pendingOperationId = (
        structured(createResponse).error as { details: { pendingOperationId: string } }
      ).details.pendingOperationId;

      const response = await call(server, "approve", "approve_l3_operation", {
        projectId,
        pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(structured(response).error).toMatchObject({
        code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
        details: { cause: expect.stringContaining("does not advertise the elicitation capability") }
      });
    } finally {
      server.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("does not mint an artifact when the host user declines", async () => {
    const projectRoot = createTempProjectRoot();
    const outbound: JsonRpcMessage[] = [];
    const server = createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      hostProfile: "codex",
      sendMessage: (message) => outbound.push(message)
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { elicitation: {} },
          clientInfo: { name: "codex", version: "0.147.0" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const initialized = await call(server, "init", "init_project", {
        name: "Authorization Probe",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      const projectId = (structured(initialized).data as { project: { id: string } }).project.id;
      const createResponse = await call(server, "create", "create_version", {
        projectId,
        title: "Version 1",
        expectedRouteLedgerRoot: projectRoot
      });
      const pendingOperationId = (
        structured(createResponse).error as { details: { pendingOperationId: string } }
      ).details.pendingOperationId;
      const approvalPromise = call(server, "approve", "approve_l3_operation", {
        projectId,
        pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      for (let attempt = 0; attempt < 20 && outbound.length === 0; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const elicitation = outbound.find(
        (message) => "method" in message && message.method === "elicitation/create"
      ) as { id: string | number };
      await server.handleMessage({
        jsonrpc: "2.0",
        id: elicitation.id,
        result: { action: "decline" }
      });

      expect(structured(await approvalPromise).error).toMatchObject({
        code: "AUTHORIZATION_GRANT_REJECTED",
        details: { reason: "HOST_DECLINED" }
      });
    } finally {
      server.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("allows a deterministically bound delegated policy without a host prompt", async () => {
    const projectRoot = createTempProjectRoot();
    const outbound: JsonRpcMessage[] = [];
    const server = createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      hostProfile: "generic",
      sendMessage: (message) => outbound.push(message)
    });

    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "generic-agent", version: "1.0.0" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const initialized = await call(server, "init", "init_project", {
        name: "Authorization Probe",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      const projectId = (structured(initialized).data as { project: { id: string } }).project.id;
      const createResponse = await call(server, "create", "create_version", {
        projectId,
        title: "Version 1",
        expectedRouteLedgerRoot: projectRoot
      });
      const details = (structured(createResponse).error as {
        details: { pendingOperationId: string; targetId: string };
      }).details;
      const proposalResponse = await call(server, "proposal", "get_l3_proposal", {
        projectId,
        pendingOperationId: details.pendingOperationId
      });
      if (structured(proposalResponse).data === undefined) {
        throw new Error(JSON.stringify(structured(proposalResponse), null, 2));
      }
      const proposal = structured(proposalResponse).data as { targetId: string };
      fs.writeFileSync(
        path.join(projectRoot, ".routeledger", "l3-authorization.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          policyId: "policy-test",
          mode: "delegated",
          binding: {
            projectId,
            routeledgerRootDigest: `sha256:${createHash("sha256").update(projectRoot).digest("hex")}`,
            hostKind: "generic",
            clientId: "generic-agent"
          },
          defaultEffect: "deny",
          rules: [{
            id: "allow-create",
            effect: "allow",
            actions: ["create_version"],
            resources: { targetIds: [proposal.targetId] },
            conditions: { gateMustPass: true }
          }],
          alwaysPrompt: []
        }, null, 2)}\n`,
        "utf8"
      );

      const response = await call(server, "approve", "approve_l3_operation", {
        projectId,
        pendingOperationId: details.pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(structured(response).data).toMatchObject({
        approvalSource: "delegated_policy",
        policyId: "policy-test",
        policyDigest: expect.any(String)
      });
      expect(outbound).toHaveLength(0);
    } finally {
      server.close();
      cleanupProjectRoot(projectRoot);
    }
  });
});
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
