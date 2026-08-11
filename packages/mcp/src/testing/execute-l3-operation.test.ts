import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MemoryL3AuthorizationGrantStore,
  type L3AuthorizationEvaluationContext
} from "@routeledger/core";

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
          requestGrant: async ({ context }: { context: L3AuthorizationEvaluationContext }) => {
            delegatedCalls += 1;
            const now = new Date();
            return {
              effect: "allow" as const,
              grant: {
                id: randomUUID(),
                issuer: "test-authority",
                subjectId: context.subjectId,
                audience: "routeledger-core",
                projectId: context.projectId,
                routeledgerRootDigest: context.routeledgerRootDigest,
                allowedActions: [context.actionType],
                allowedTargetIds: [context.targetId],
                operationDigest: context.operationDigest,
                scope: "operation" as const,
                source: "delegated_policy" as const,
                policyId: "policy-d3",
                policyDigest: "policy-digest-d3",
                decisionId: randomUUID(),
                hostKind: "generic",
                clientId: "automatic-client",
                sessionId: "automatic-session",
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
          commit: { replayed: false }
        }
      });
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

  it("fails before proposal creation when Codex permission context is unavailable", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot, {
      hostProfile: "codex",
      hostPermissionContext: {
        status: "unavailable",
        code: "CODEX_PERMISSION_CONTEXT_UNAVAILABLE",
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
        reason: "Must not guess",
        idempotencyKey: "unavailable"
      });

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
          details: { reason: "CODEX_PERMISSION_CONTEXT_UNAVAILABLE" }
        }
      });
      const proposals = await registry.invoke("list_l3_proposals", { projectId });
      expect(proposals.data).toHaveLength(0);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });
});
