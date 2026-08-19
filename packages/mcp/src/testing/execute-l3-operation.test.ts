import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MemoryExactAuthorizationStore
} from "@routeledger/core";
import type { RouteLedgerMcpDelegatedAuthorizationRequest } from "../index.js";

import {
  cleanupProjectRoot,
  createRegistry,
  createTempProjectRoot
} from "./mcp-test-helpers.js";

describe("execute_route_change operation=execute_l3_operation", () => {
  it("completes one automatic external call and replays the exact idempotent request", async () => {
    const projectRoot = createTempProjectRoot();
    let delegatedCalls = 0;
    const registry = createRegistry(projectRoot, {
      l3Authorization: {
        exactStore: new MemoryExactAuthorizationStore(),
        interaction: {
          requestAuthorization: async () => {
            throw new Error("automatic execution must not prompt");
          }
        },
        sessionId: "automatic-session",
        trustedClientId: "automatic-client",
        delegatedAuthority: {
          authorityHandle: "host-vault://d3-test",
          issuerId: "test-authority",
          policyId: "policy-d3",
          policyDigest: "policy-digest-d3",
          requestExactDecision: async ({ proposal, context }: RouteLedgerMcpDelegatedAuthorizationRequest) => {
            delegatedCalls += 1;
            const now = new Date();
            return {
              effect: "allow" as const,
              authorization: {
                schemaVersion: 2,
                authorizationId: randomUUID(),
                binding: {
                  proposalId: proposal.id,
                  projectId: context.projectId,
                  routeledgerRootDigest: context.routeledgerRootDigest,
                  actionType: context.actionType,
                  targetId: context.targetId,
                  operationDigest: context.operationDigest
                },
                issuer: "test-authority",
                subjectId: context.subjectId,
                audience: "routeledger-core",
                source: "delegated_policy" as const,
                policyId: "policy-d3",
                policyDigest: "policy-digest-d3",
                decisionRef: randomUUID(),
                profileId: null,
                modeEpoch: null,
                profileDigest: null,
                hostKind: "generic",
                clientId: "automatic-client",
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 60_000).toISOString()
              }
            };
          }
        }
      }
    });

    try {
      const initialized = await registry.invoke("configure_project", {
        operation: "initialize",
        name: "D3",
        contentLocale: "en",
        firstVersion: { title: "Initial Version", initialTodos: [] }
      });
      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const versionId = (initialized.data as { firstVersion: { id: string } }).firstVersion.id;
      await registry.invoke("set_version_state", {
        operation: "prepare",
        projectId,
        versionId
      });
      const request = {
        operation: "execute_l3_operation",
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "Start through the D3 orchestrator",
        idempotencyKey: "start-initial-version"
      };

      const [first, duplicate] = await Promise.all([
        registry.invoke("execute_route_change", request),
        registry.invoke("execute_route_change", request)
      ]);
      const retry = await registry.invoke("execute_route_change", request);

      expect(first).toMatchObject({
        ok: true,
        data: {
          status: "committed",
          decisionArtifact: {
            artifactId: expect.any(String),
            authorizationId: expect.any(String),
            proposalId: expect.any(String),
            routeledgerRootDigest: expect.any(String),
            source: "delegated_policy",
            operationDigest: expect.any(String)
          },
          commit: { replayed: false }
        }
      });
      expect(first.data).not.toHaveProperty("approvalArtifact");
      expect(retry).toMatchObject({
        ok: true,
        data: {
          status: "committed",
          proposalId: (first.data as { proposalId: string }).proposalId,
          commit: { replayed: true }
        }
      });
      expect(duplicate).toMatchObject({
        ok: true,
        data: {
          status: "committed",
          proposalId: (first.data as { proposalId: string }).proposalId,
          commit: { replayed: false }
        }
      });

      const proposals = await registry.invoke("inspect_l3_route_operations", {
        operation: "list_l3_proposals",
        projectId
      });
      expect(proposals.data).toHaveLength(1);
      expect(delegatedCalls).toBe(1);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("fails closed when an idempotency key is reused for another request", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const initialized = await registry.invoke("configure_project", {
        operation: "initialize",
        name: "D3 conflict",
        contentLocale: "en",
        firstVersion: { title: "Initial Version", initialTodos: [] }
      });
      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const versionId = (initialized.data as { firstVersion: { id: string } }).firstVersion.id;
      await registry.invoke("set_version_state", {
        operation: "prepare",
        projectId,
        versionId
      });
      await registry.invoke("execute_route_change", {
        operation: "execute_l3_operation",
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "First binding",
        idempotencyKey: "fixed-key"
      });

      const conflict = await registry.invoke("execute_route_change", {
        operation: "execute_l3_operation",
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "Different request",
        idempotencyKey: "fixed-key"
      });

      expect(conflict).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          details: { reason: "IDEMPOTENCY_KEY_REUSE_MISMATCH" }
        }
      });
      const proposals = await registry.invoke("inspect_l3_route_operations", {
        operation: "list_l3_proposals",
        projectId
      });
      expect(proposals.data).toHaveLength(1);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("keeps exact L3 workflows as discriminated composite operations", () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    try {
      expect(registry.getTool("propose_l3_route_change")).toBeDefined();
      const executeTool = registry.getTool("execute_route_change");
      expect(executeTool).toBeDefined();
      const operations = (executeTool!.inputSchema.oneOf as Array<{
        properties: { operation: { const: string } };
      }>).map((branch) => branch.properties.operation.const);
      expect(operations).toEqual([
        "force_shutdown",
        "execute_l3_operation",
        "approve_l3_operation",
        "commit_l3_operation",
        "reject_l3_operation"
      ]);
      for (const removedName of [
        "propose_l3_operation",
        "execute_l3_operation",
        "approve_l3_operation",
        "reject_l3_operation",
        "commit_l3_operation"
      ]) {
        expect(registry.getTool(removedName)).toBeUndefined();
      }
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("[0.7.2 golden] completes one-call Codex native admission without a permission profile", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot, {
      hostProfile: "codex",
      hostPermissionContext: {
        status: "unavailable",
        code: "CODEX_PERMISSION_CONTEXT_UNAVAILABLE",
        codexPermissionProfile: null,
        reason: "No effective Codex permission context"
      }
    });
    try {
      const initialized = await registry.invoke("configure_project", {
        operation: "initialize",
        name: "D4 unavailable",
        contentLocale: "en",
        firstVersion: { title: "Initial Version", initialTodos: [] }
      });
      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const versionId = (initialized.data as { firstVersion: { id: string } }).firstVersion.id;
      await registry.invoke("set_version_state", {
        operation: "prepare",
        projectId,
        versionId
      });

      const response = await registry.invoke("execute_route_change", {
        operation: "execute_l3_operation",
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "The Codex host admitted this high-risk tool call",
        idempotencyKey: "unavailable"
      });

      expect(response).toMatchObject({
        ok: true,
        data: {
          status: "committed",
          decisionArtifact: {
            artifactId: expect.any(String),
            authorizationId: expect.any(String),
            routeledgerRootDigest: expect.any(String),
            source: "host_admission",
            operationDigest: expect.any(String)
          }
        }
      });
      const status = await registry.invoke("inspect_l3_route_operations", {
        operation: "get_l3_authorization_status",
        detail: "internal"
      });
      expect(status).toMatchObject({
        ok: true,
        data: {
          controlPlane: "codex_native_tool_admission_v2",
          authorizationBackend: "exact_authorization_receipt",
          profileCompatible: null,
          effectiveMode: {
            status: "host_managed",
            mode: null,
            source: "codex_native_tool_admission",
            profileCompatible: null
          },
          recommendedNextActions: []
        }
      });
      const proposals = await registry.invoke("inspect_l3_route_operations", {
        operation: "list_l3_proposals",
        projectId
      });
      expect(proposals.data).toHaveLength(1);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("[0.7.2 golden] completes explicit propose, approve, and commit through native Codex admission", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot, {
      hostProfile: "codex",
      hostPermissionContext: {
        status: "unavailable",
        code: "CODEX_PERMISSION_CONTEXT_UNAVAILABLE",
        codexPermissionProfile: null,
        reason: "No forwarded permission-profile environment"
      }
    });
    try {
      const initialized = await registry.invoke("configure_project", {
        operation: "initialize",
        name: "Codex explicit flow",
        contentLocale: "en",
        firstVersion: { title: "Initial Version", initialTodos: [] }
      });
      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const versionId = (initialized.data as { firstVersion: { id: string } }).firstVersion.id;
      await registry.invoke("set_version_state", {
        operation: "prepare",
        projectId,
        versionId
      });

      const proposed = await registry.invoke("propose_l3_route_change", {
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "Verify the explicit Windows Desktop flow"
      });
      const pendingOperationId = (proposed.data as { id: string }).id;
      const approved = await registry.invoke("execute_route_change", {
        operation: "approve_l3_operation",
        projectId,
        pendingOperationId
      });
      const approval = approved.data as {
        id: string;
        approvalSource: string;
        status: string;
      };
      expect(approval).toMatchObject({
        approvalSource: "host_admission",
        status: "approved"
      });

      const committed = await registry.invoke("execute_route_change", {
        operation: "commit_l3_operation",
        projectId,
        pendingOperationId,
        approvalArtifactId: approval.id
      });
      expect(committed).toMatchObject({
        ok: true,
        data: {
          pendingOperation: { status: "committed" },
          approvalArtifact: {
            id: approval.id,
            status: "consumed",
            approvalSource: "host_admission"
          },
          replayed: false
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("reports the Codex permission adapter separately from its compatibility backend", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot, {
      hostProfile: "codex",
      hostPermissionContext: {
        status: "resolved",
        mode: "preauthorized",
        source: "codex_permission_profile",
        codexPermissionProfile: ":danger-full-access",
        fallbackUsed: false
      }
    });
    try {
      await registry.invoke("configure_project", {
        operation: "initialize",
        name: "Codex status projection",
        contentLocale: "en",
        firstVersion: { title: "Initial Version", initialTodos: [] }
      });
      const response = await registry.invoke("inspect_l3_route_operations", {
        operation: "get_l3_authorization_status"
      });
      expect(response).toMatchObject({
        ok: true,
        data: {
          controlPlane: "codex_native_tool_admission_v2",
          authorizationBackend: "exact_authorization_receipt",
          profile: null,
          profileCompatible: null,
          effectiveMode: {
            mode: "preauthorized",
            source: "codex_permission_profile",
            codexPermissionProfile: ":danger-full-access",
            fallbackUsed: false,
            profileCompatible: null
          },
          recommendedNextActions: []
        }
      });
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });
});
