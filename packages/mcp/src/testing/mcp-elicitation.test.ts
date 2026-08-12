import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  digestL3AuthorizationProfile,
  MemoryL3AuthorizationGrantStore,
  type L3AuthorizationMode,
  type L3AuthorizationProfileV2
} from "@routeledger/core";

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

const profileFor = (input: {
  mode: L3AuthorizationMode;
  projectId: string;
  projectRoot: string;
}): L3AuthorizationProfileV2 => {
  const rootDigest = `sha256:${createHash("sha256")
    .update(fs.realpathSync.native(input.projectRoot))
    .digest("hex")}`;
  const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
    schemaVersion: 3,
    profileId: `profile-${input.mode}`,
    status: "active",
    binding: {
      projectId: input.projectId,
      workspaceRootDigest: rootDigest,
      routeledgerRootDigest: rootDigest,
      subjectId: "mcp-user",
      hostKind: "generic",
      trustedClientId: "trusted-v3-client"
    },
    mode: input.mode,
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy: null,
    limits: { maxAuthorizationTtlSeconds: 300 },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
  return { ...base, profileDigest: digestL3AuthorizationProfile(base) };
};

describe("MCP L3 authorization elicitation", () => {
  it.todo("[EA3 target red] generic exact elicitation omits scope and rejects legacy scope content");

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
        clientId: null,
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
      fs.writeFileSync(
        path.join(projectRoot, ".routeledger", "l3-authorization.json"),
        '{"mode":"delegated","rules":[{"effect":"allow"}]}\n',
        "utf8"
      );

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

  it("uses only a host-injected delegated authority and enforces its atomic budget", async () => {
    const projectRoot = createTempProjectRoot();
    const outbound: JsonRpcMessage[] = [];
    const grantStore = new MemoryL3AuthorizationGrantStore();
    let remainingUses = 1;
    const server = createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      hostProfile: "generic",
      sendMessage: (message) => outbound.push(message),
      l3Authorization: {
        grantStore,
        interaction: {
          requestAuthorization: async () => {
            throw new Error("host prompt must not be used for delegated allow");
          }
        },
        sessionId: "trusted-session",
        trustedClientId: "trusted-host-client",
        delegatedAuthority: {
          authorityHandle: "host-vault://policy-test",
          requestGrant: async ({ context }) => {
            if (remainingUses === 0) {
              return {
                effect: "deny" as const,
                code: "POLICY_USE_BUDGET_EXHAUSTED",
                policyId: "policy-test",
                policyDigest: "policy-digest-test",
                matchedRuleId: "allow-create"
              };
            }
            remainingUses -= 1;
            const now = new Date();
            return {
              effect: "allow" as const,
              grant: {
                id: randomUUID(),
                issuer: "trusted-host-authority",
                subjectId: context.subjectId!,
                audience: "routeledger-core",
                projectId: context.projectId,
                routeledgerRootDigest: context.routeledgerRootDigest,
                allowedActions: [context.actionType],
                allowedTargetIds: [context.targetId],
                operationDigest: context.operationDigest,
                scope: "operation" as const,
                source: "delegated_policy" as const,
                policyId: "policy-test",
                policyDigest: "policy-digest-test",
                decisionId: randomUUID(),
                hostKind: "generic",
                clientId: "trusted-host-client",
                sessionId: "trusted-session",
                nonce: randomUUID(),
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 60_000).toISOString(),
                maxUses: 1,
                uses: 0,
                status: "active" as const,
                revokedAt: null
              }
            };
          }
        }
      }
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
      const response = await call(server, "approve", "approve_l3_operation", {
        projectId,
        pendingOperationId: details.pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      if (structured(response).data === undefined) {
        throw new Error(JSON.stringify(structured(response), null, 2));
      }
      expect(structured(response).data).toMatchObject({
        approvalSource: "delegated_policy",
        policyId: "policy-test",
        policyDigest: "policy-digest-test",
        clientId: "trusted-host-client"
      });
      expect(outbound).toHaveLength(0);

      const secondCreate = await call(server, "create-2", "create_version", {
        projectId,
        title: "Version 2",
        expectedRouteLedgerRoot: projectRoot
      });
      const secondPendingOperationId = (
        structured(secondCreate).error as { details: { pendingOperationId: string } }
      ).details.pendingOperationId;
      const exhausted = await call(server, "approve-2", "approve_l3_operation", {
        projectId,
        pendingOperationId: secondPendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(structured(exhausted).error).toMatchObject({
        code: "AUTHORIZATION_POLICY_DENIED",
        details: { decisionCode: "POLICY_USE_BUDGET_EXHAUSTED" }
      });
    } finally {
      server.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("does not promote a host-injected legacy preauthorization into exact authority", async () => {
    const projectRoot = createTempProjectRoot();
    const grantStore = new MemoryL3AuthorizationGrantStore();
    const server = createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      hostProfile: "generic",
      l3Authorization: {
        grantStore,
        interaction: {
          requestAuthorization: async () => {
            throw new Error("preauthorization must not prompt");
          }
        },
        sessionId: "preauthorized-session",
        trustedClientId: "trusted-preauthorized-client"
      }
    });
    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "self-reported-name", version: "1.0.0" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const initialized = await call(server, "init", "init_project", {
        name: "Preauthorization Probe",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      const projectId = (structured(initialized).data as { project: { id: string } }).project.id;
      const created = await call(server, "create", "create_version", {
        projectId,
        title: "Version 1",
        expectedRouteLedgerRoot: projectRoot
      });
      const pendingOperationId = (
        structured(created).error as { details: { pendingOperationId: string } }
      ).details.pendingOperationId;
      const proposalResponse = await call(server, "proposal", "get_l3_proposal", {
        projectId,
        pendingOperationId
      });
      const proposal = structured(proposalResponse).data as {
        actionType: "create_version";
        targetId: string;
        digest: { value: string };
      };
      const now = new Date();
      await grantStore.issue({
        id: "preauthorized-grant",
        issuer: "trusted-host-preauthorization",
        subjectId: "mcp-user",
        audience: "routeledger-core",
        projectId,
        routeledgerRootDigest: `sha256:${createHash("sha256")
          .update(fs.realpathSync.native(projectRoot))
          .digest("hex")}`,
        allowedActions: [proposal.actionType],
        allowedTargetIds: [proposal.targetId],
        operationDigest: proposal.digest.value,
        scope: "operation",
        source: "preauthorized",
        policyId: null,
        policyDigest: null,
        decisionId: "preauthorized-decision",
        hostKind: "generic",
        clientId: "trusted-preauthorized-client",
        sessionId: "preauthorized-session",
        nonce: randomUUID(),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        maxUses: 1,
        uses: 0,
        status: "active",
        revokedAt: null
      });

      const response = await call(server, "approve", "approve_l3_operation", {
        projectId,
        pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(structured(response).error).toMatchObject({
        code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE"
      });
    } finally {
      server.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("enforces V3 preauthorized miss and trusted interactive provenance without fallback mixing", async () => {
    const projectRoot = createTempProjectRoot();
    const bootstrap = createRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      hostProfile: "generic"
    });
    try {
      await bootstrap.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "bootstrap", version: "1" }
        }
      });
      await bootstrap.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const initialized = await call(bootstrap, "init", "init_project", {
        name: "V3 Mode Probe",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      const projectId = (structured(initialized).data as { project: { id: string } }).project.id;
      const created = await call(bootstrap, "create", "create_version", {
        projectId,
        title: "Version 1",
        expectedRouteLedgerRoot: projectRoot
      });
      const pendingOperationId = (
        structured(created).error as { details: { pendingOperationId: string } }
      ).details.pendingOperationId;
      bootstrap.close();

      let interactionCalls = 0;
      const preauthorized = createRouteLedgerStdioServer({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot,
        hostProfile: "generic",
        l3Authorization: {
          grantStore: new MemoryL3AuthorizationGrantStore(),
          profile: profileFor({ mode: "preauthorized", projectId, projectRoot }),
          interaction: {
            requestAuthorization: async () => {
              interactionCalls += 1;
              return { action: "accept", content: { approve: true, scope: "operation" } };
            }
          },
          sessionId: "v3-session",
          trustedClientId: "trusted-v3-client"
        }
      });
      await preauthorized.handleMessage({
        jsonrpc: "2.0",
        id: "initialize-preauthorized",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { elicitation: {} },
          clientInfo: { name: "untrusted-client-name", version: "1" }
        }
      });
      await preauthorized.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const status = await call(
        preauthorized,
        "authorization-status",
        "get_l3_authorization_status",
        {}
      );
      expect(structured(status).data).toMatchObject({
        controlPlane: "host_authority_broker_v2",
        profile: {
          mode: "preauthorized"
        },
        management: "host_only"
      });
      expect((structured(status).data as { profile: Record<string, unknown> }).profile).not.toHaveProperty(
        "profileId"
      );
      const internalStatus = await call(
        preauthorized,
        "authorization-status-internal",
        "get_l3_authorization_status",
        { detail: "internal" }
      );
      expect(structured(internalStatus).data).toMatchObject({
        profile: {
          mode: "preauthorized",
          internal: {
            profileId: "profile-preauthorized",
            modeEpoch: 1,
            profileRevision: 1
          }
        }
      });
      const recommendation = await call(
        preauthorized,
        "authorization-recommendation",
        "recommend_l3_authorization_profile",
        { projectId, mode: "interactive" }
      );
      expect(structured(recommendation).data).toMatchObject({
        candidateOnly: true,
        profile: {
          schemaVersion: 3,
          mode: "interactive",
          modeEpoch: 1,
          profileRevision: 1,
          delegatedPolicy: null,
          binding: {
            projectId,
            subjectId: "mcp-user",
            hostKind: "generic",
            trustedClientId: "trusted-v3-client"
          }
        },
        recommendedChecklist: expect.arrayContaining([
          expect.stringContaining("host authority broker")
        ])
      });
      const miss = await call(preauthorized, "approve-miss", "approve_l3_operation", {
        projectId,
        pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(structured(miss).error).toMatchObject({ code: "PREAUTHORIZATION_GRANT_REQUIRED" });
      expect(interactionCalls).toBe(0);
      preauthorized.close();

      const interactiveProfile = profileFor({ mode: "interactive", projectId, projectRoot });
      const untrustedInteractive = createRouteLedgerStdioServer({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot,
        hostProfile: "generic",
        l3Authorization: {
          grantStore: new MemoryL3AuthorizationGrantStore(),
          profile: interactiveProfile,
          interaction: {
            requestAuthorization: async () => ({
              action: "accept",
              content: { approve: true, scope: "operation" }
            })
          },
          sessionId: "v3-session",
          trustedClientId: "trusted-v3-client"
        }
      });
      await untrustedInteractive.handleMessage({
        jsonrpc: "2.0",
        id: "initialize-interactive",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { elicitation: {} },
          clientInfo: { name: "spoofed-user-client", version: "1" }
        }
      });
      await untrustedInteractive.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const noProvenance = await call(
        untrustedInteractive,
        "approve-untrusted",
        "approve_l3_operation",
        { projectId, pendingOperationId, expectedRouteLedgerRoot: projectRoot }
      );
      expect(structured(noProvenance).error).toMatchObject({
        code: "TRUSTED_HOST_USER_DECISION_REQUIRED"
      });
      untrustedInteractive.close();

      const trustedInteractive = createRouteLedgerStdioServer({
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot,
        hostProfile: "generic",
        l3Authorization: {
          grantStore: new MemoryL3AuthorizationGrantStore(),
          profile: interactiveProfile,
          interaction: {
            requestAuthorization: async () => ({
              action: "accept",
              content: { approve: true, scope: "operation" },
              trustedDecision: {
                kind: "trusted_host_user",
                hostKind: "generic",
                decisionId: "trusted-decision-1"
              }
            })
          },
          sessionId: "v3-session",
          trustedClientId: "trusted-v3-client"
        }
      });
      await trustedInteractive.handleMessage({
        jsonrpc: "2.0",
        id: "initialize-trusted",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "still-untrusted-client-name", version: "1" }
        }
      });
      await trustedInteractive.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const approved = await call(trustedInteractive, "approve-trusted", "approve_l3_operation", {
        projectId,
        pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(structured(approved).data).toMatchObject({
        approvalSource: "user_interaction",
        decisionRef: "trusted-decision-1",
        profileId: interactiveProfile.profileId,
        modeEpoch: interactiveProfile.modeEpoch,
        profileDigest: interactiveProfile.profileDigest
      });
      trustedInteractive.close();
    } finally {
      bootstrap.close();
      cleanupProjectRoot(projectRoot);
    }
  });
});
