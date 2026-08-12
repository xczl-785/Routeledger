import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MemoryL3AuthorizationGrantStore
} from "@routeledger/core";
import type { RouteLedgerMcpDelegatedAuthorizationRequest } from "../index.js";

import {
  cleanupProjectRoot,
  createRegistry,
  createTempProjectRoot
} from "./mcp-test-helpers.js";

describe("execute_l3_operation", () => {
  it("completes one automatic external call and replays the exact idempotent request", async () => {
    const projectRoot = createTempProjectRoot();
    let delegatedCalls = 0;
    const registry = createRegistry(projectRoot, {
      l3Authorization: {
        grantStore: new MemoryL3AuthorizationGrantStore(),
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
                sessionId: null,
                createdAt: now.toISOString(),
                expiresAt: new Date(now.getTime() + 60_000).toISOString()
              }
            };
          }
        }
      }
    });

    try {
      const initialized = await registry.invoke("init_project", { name: "D3" });
      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const versionId = (initialized.data as { firstVersion: { id: string } }).firstVersion.id;
      await registry.invoke("prepare_version", { projectId, versionId });
      const request = {
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "Start through the D3 orchestrator",
        idempotencyKey: "start-initial-version"
      };

      const [first, duplicate] = await Promise.all([
        registry.invoke("execute_l3_operation", request),
        registry.invoke("execute_l3_operation", request)
      ]);
      const retry = await registry.invoke("execute_l3_operation", request);

      expect(first).toMatchObject({
        ok: true,
        data: {
          status: "committed",
          decisionArtifact: {
            proposalId: expect.any(String),
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

      const proposals = await registry.invoke("list_l3_proposals", { projectId });
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
      const initialized = await registry.invoke("init_project", { name: "D3 conflict" });
      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const versionId = (initialized.data as { firstVersion: { id: string } }).firstVersion.id;
      await registry.invoke("prepare_version", { projectId, versionId });
      await registry.invoke("execute_l3_operation", {
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "First binding",
        idempotencyKey: "fixed-key"
      });

      const conflict = await registry.invoke("execute_l3_operation", {
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
      const proposals = await registry.invoke("list_l3_proposals", { projectId });
      expect(proposals.data).toHaveLength(1);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("keeps the low-level L3 tools registered", () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    try {
      expect([
        "propose_l3_operation",
        "approve_l3_operation",
        "reject_l3_operation",
        "commit_l3_operation"
      ].every((name) => registry.getTool(name) !== undefined)).toBe(true);
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
      const initialized = await registry.invoke("init_project", { name: "D4 unavailable" });
      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const versionId = (initialized.data as { firstVersion: { id: string } }).firstVersion.id;
      await registry.invoke("prepare_version", { projectId, versionId });

      const response = await registry.invoke("execute_l3_operation", {
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
            source: "host_admission",
            operationDigest: expect.any(String)
          }
        }
      });
      const status = await registry.invoke("get_l3_authorization_status", { detail: "internal" });
      expect(status).toMatchObject({
        ok: true,
        data: {
          controlPlane: "codex_native_tool_admission_v2",
          authorizationBackend: "exact_grant_receipt",
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
      const proposals = await registry.invoke("list_l3_proposals", { projectId });
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
      const initialized = await registry.invoke("init_project", { name: "Codex explicit flow" });
      const projectId = (initialized.data as { project: { id: string } }).project.id;
      const versionId = (initialized.data as { firstVersion: { id: string } }).firstVersion.id;
      await registry.invoke("prepare_version", { projectId, versionId });

      const proposed = await registry.invoke("propose_l3_operation", {
        projectId,
        actionType: "start_version",
        targetId: versionId,
        reason: "Verify the explicit Windows Desktop flow"
      });
      const pendingOperationId = (proposed.data as { id: string }).id;
      const approved = await registry.invoke("approve_l3_operation", {
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

      const committed = await registry.invoke("commit_l3_operation", {
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
      await registry.invoke("init_project", { name: "Codex status projection" });
      const response = await registry.invoke("get_l3_authorization_status", {});
      expect(response).toMatchObject({
        ok: true,
        data: {
          controlPlane: "codex_native_tool_admission_v2",
          authorizationBackend: "exact_grant_receipt",
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
