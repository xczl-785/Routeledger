import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  buildBalancedL3AuthorizationPolicy,
  type L3AuthorizationEvaluationContext,
  type ExactAuthorizationCandidate,
  type L3AuthorizationGrant,
  type PendingOperation
} from "@routeledger/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  installLocalL3AuthorityConfig,
  loadLocalL3AuthorityRuntime,
  type LocalL3AuthorityConfig
} from "../local-l3-authorization.js";
import { MCP_PROTOCOL_VERSION, createRouteLedgerMcpRegistry } from "../index.js";
import { runRouteLedgerStdioServer } from "../stdio-server.js";
import { createRegistry } from "./mcp-test-helpers.js";

const roots: string[] = [];

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const createFixture = async (maxUses = 2) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-local-l3-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const authorityRoot = path.join(root, "host-authority");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(authorityRoot, { recursive: true, mode: 0o700 });
  const configPath = path.join(authorityRoot, "authority.json");
  const statePath = path.join(authorityRoot, "authority.state.json");
  const policy = buildBalancedL3AuthorizationPolicy({
    policyId: "policy-local",
    projectId: "project-1",
    routeledgerRootDigest: "root-digest",
    currentVersionId: "version-1",
    routeVersionIds: ["version-1", "version-2"],
    expiresAt: "2026-08-11T00:00:00.000Z",
    maxUses,
    subjectId: "mcp-user",
    hostKind: "generic",
    clientId: "trusted-client"
  });
  const config: LocalL3AuthorityConfig = {
    schemaVersion: 1,
    authorityId: "authority-local",
    statePath,
    policy,
    grantTtlSeconds: 300,
    trustedClientId: "trusted-client"
  };
  await installLocalL3AuthorityConfig({
    configPath,
    workspaceRoot,
    routeledgerRoot: workspaceRoot,
    config
  });
  return { root, workspaceRoot, authorityRoot, configPath, statePath, config };
};

const evaluationContext = (
  operationDigest: string
): L3AuthorizationEvaluationContext => ({
  projectId: "project-1",
  routeledgerRootDigest: "root-digest",
  actionType: "start_version",
  targetId: "version-2",
  currentVersionId: "version-1",
  targetRelation: "legal-successor",
  gateAllowed: true,
  operationDigest,
  now: "2026-08-10T08:00:00.000Z",
  subjectId: "mcp-user",
  hostKind: "generic",
  clientId: "trusted-client"
});

const proposalFor = (context: L3AuthorizationEvaluationContext): PendingOperation => ({
  id: `proposal-${context.operationDigest}`,
  projectId: context.projectId,
  actionType: context.actionType,
  targetId: context.targetId,
  status: "pending",
  reason: "test exact authority",
  gateSnapshot: { kind: "none", evaluatedAt: context.now, allowed: true, blockers: [] },
  digest: { algorithm: "sha256", value: context.operationDigest, payload: {} },
  payload: {},
  createdBy: { id: "test", type: "agent" },
  createdAt: context.now,
  updatedAt: context.now,
  committedAt: null,
  rejectedAt: null,
  rejectionReason: null,
  approvalArtifactId: null
});

const legacyGrantFor = (authorization: ExactAuthorizationCandidate): L3AuthorizationGrant => ({
  id: authorization.authorizationId,
  issuer: authorization.issuer,
  subjectId: authorization.subjectId,
  audience: authorization.audience,
  projectId: authorization.binding.projectId,
  routeledgerRootDigest: authorization.binding.routeledgerRootDigest,
  allowedActions: [authorization.binding.actionType],
  allowedTargetIds: [authorization.binding.targetId],
  operationDigest: authorization.binding.operationDigest,
  scope: "operation",
  source: authorization.source,
  policyId: authorization.policyId,
  policyDigest: authorization.policyDigest,
  decisionId: authorization.decisionRef,
  hostKind: authorization.hostKind,
  clientId: authorization.clientId,
  sessionId: null,
  nonce: `legacy-${authorization.authorizationId}`,
  createdAt: authorization.createdAt,
  expiresAt: authorization.expiresAt,
  maxUses: 1,
  uses: 0,
  status: "active",
  revokedAt: null
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local L3 authorization runtime", () => {
  it("rejects authority config and state paths inside the Agent-writable workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-local-l3-boundary-"));
    roots.push(root);
    const configPath = path.join(root, "authority.json");
    const policy = buildBalancedL3AuthorizationPolicy({
      policyId: "unsafe",
      projectId: "project-1",
      routeledgerRootDigest: "root-digest",
      currentVersionId: null,
      routeVersionIds: ["version-1"],
      expiresAt: "2026-08-11T00:00:00.000Z",
      maxUses: 1,
      subjectId: "mcp-user",
      hostKind: "generic"
    });
    await expect(
      installLocalL3AuthorityConfig({
        configPath,
        workspaceRoot: root,
        routeledgerRoot: root,
        config: {
          schemaVersion: 1,
          authorityId: "unsafe",
          statePath: path.join(root, "state.json"),
          policy,
          grantTtlSeconds: 60
        }
      })
    ).rejects.toThrow("outside the workspace");
  });

  it("persists exact authorizations without writing legacy grants across reconstruction", async () => {
    const fixture = await createFixture();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const context = evaluationContext("digest-1");
    const decision = await runtime.authority.requestExactDecision({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: proposalFor(context),
      context
    });
    expect(decision.effect).toBe("allow");
    if (decision.effect !== "allow") throw new Error("expected delegated grant");
    await expect(runtime.grantStore.issue(legacyGrantFor(decision.authorization))).rejects.toThrow("audit-only");
    await expect(runtime.grantStore.get(decision.authorization.authorizationId)).resolves.toBeNull();
    await expect(runtime.exactStore.get(decision.authorization.authorizationId)).resolves.toMatchObject({
      binding: { operationDigest: "digest-1" },
      source: "delegated_policy"
    });

    const restarted = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    await expect(restarted.exactStore.get(decision.authorization.authorizationId)).resolves.toMatchObject({
      binding: { operationDigest: "digest-1" }
    });
  });

  it("keeps exact duplicate issue and receipt writes idempotent across store implementations", async () => {
    const fixture = await createFixture();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const decision = await runtime.authority.requestExactDecision({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: proposalFor(evaluationContext("store-contract")),
      context: evaluationContext("store-contract")
    });
    if (decision.effect !== "allow") throw new Error("expected delegated grant");
    await expect(runtime.exactStore.issue(structuredClone(decision.authorization))).resolves.toBeUndefined();
    await expect(
      runtime.exactStore.issue({ ...decision.authorization, issuer: "conflicting-issuer" })
    ).rejects.toThrow("already exists");
    await expect(runtime.grantStore.issue(legacyGrantFor(decision.authorization))).rejects.toThrow("audit-only");
  });

  it("atomically enforces the delegated rule budget across concurrent requests", async () => {
    const fixture = await createFixture(1);
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const results = await Promise.all(
      ["digest-a", "digest-b"].map((digest) =>
        runtime.authority.requestExactDecision({
          authorityHandle: runtime.authority.authorityHandle,
          proposal: proposalFor(evaluationContext(digest)),
          context: evaluationContext(digest)
        })
      )
    );
    expect(results.filter((result) => result.effect === "allow")).toHaveLength(1);
    expect(results.filter((result) => result.effect === "deny")).toHaveLength(1);
    expect(results.find((result) => result.effect === "deny")).toMatchObject({
      code: "POLICY_BUDGET_EXHAUSTED"
    });
  });

  it("does not reclaim an expired lease while its owner process is still alive", async () => {
    const fixture = await createFixture(1);
    let blockTransaction = false;
    const entered = deferred();
    const resume = deferred();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user",
      testHooks: {
        heartbeatIntervalMs: 60_000,
        lockWaitTimeoutMs: 150,
        lockRetryMs: 10,
        afterStateRead: async () => {
          if (!blockTransaction) return;
          entered.resolve();
          await resume.promise;
        }
      }
    });
    blockTransaction = true;
    const firstRequest = runtime.authority.requestExactDecision({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: proposalFor(evaluationContext("long-transaction")),
      context: evaluationContext("long-transaction")
    });
    await entered.promise;

    const lockPath = `${fixture.statePath}.lock`;
    const metadataPath = path.join(lockPath, "metadata.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
      updatedAt: string;
    };
    metadata.updatedAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(lockPath, old, old);

    await expect(
      runtime.authority.requestExactDecision({
        authorityHandle: runtime.authority.authorityHandle,
        proposal: proposalFor(evaluationContext("competing-transaction")),
        context: evaluationContext("competing-transaction")
      })
    ).rejects.toThrow("Timed out waiting");
    resume.resolve();
    await expect(firstRequest).resolves.toMatchObject({ effect: "allow" });
    blockTransaction = false;
    await expect(
      runtime.authority.requestExactDecision({
        authorityHandle: runtime.authority.authorityHandle,
        proposal: proposalFor(evaluationContext("competing-transaction")),
        context: evaluationContext("competing-transaction")
      })
    ).resolves.toMatchObject({ effect: "deny", code: "POLICY_BUDGET_EXHAUSTED" });
  });

  it("heartbeats an active state lease", async () => {
    const fixture = await createFixture();
    let blockTransaction = false;
    const entered = deferred();
    const resume = deferred();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user",
      testHooks: {
        heartbeatIntervalMs: 20,
        afterStateRead: async () => {
          if (!blockTransaction) return;
          entered.resolve();
          await resume.promise;
        }
      }
    });
    blockTransaction = true;
    const transaction = runtime.grantStore.revoke("missing", new Date().toISOString());
    await entered.promise;
    const lockPath = `${fixture.statePath}.lock`;
    const metadataPath = path.join(lockPath, "metadata.json");
    const before = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { updatedAt: string };
    await new Promise((resolve) => setTimeout(resolve, 70));
    const after = JSON.parse(await fs.readFile(metadataPath, "utf8")) as { updatedAt: string };
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
    resume.resolve();
    await expect(transaction).resolves.toBeNull();
  });

  it("rejects a former owner's write without releasing the replacement owner", async () => {
    const fixture = await createFixture();
    let blockTransaction = false;
    const entered = deferred();
    const resume = deferred();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user",
      testHooks: {
        heartbeatIntervalMs: 60_000,
        afterStateRead: async () => {
          if (!blockTransaction) return;
          entered.resolve();
          await resume.promise;
        }
      }
    });
    blockTransaction = true;
    const transaction = runtime.grantStore.revoke("missing", new Date().toISOString());
    await entered.promise;
    const lockPath = `${fixture.statePath}.lock`;
    const formerLockPath = `${lockPath}.former`;
    await fs.rename(lockPath, formerLockPath);
    await fs.mkdir(lockPath, { mode: 0o700 });
    const replacementMetadata = {
      lockId: "replacement-owner",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: process.pid
    };
    await fs.writeFile(
      path.join(lockPath, "metadata.json"),
      `${JSON.stringify(replacementMetadata, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    resume.resolve();
    await expect(transaction).rejects.toThrow("ownership was lost");
    await expect(fs.readFile(path.join(lockPath, "metadata.json"), "utf8")).resolves.toContain(
      "replacement-owner"
    );
    await fs.rm(lockPath, { recursive: true, force: true });
    await fs.rm(formerLockPath, { recursive: true, force: true });
  });

  it("fails closed when the state revision changes inside a locked transaction", async () => {
    const fixture = await createFixture();
    let blockTransaction = false;
    const entered = deferred();
    const resume = deferred();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user",
      testHooks: {
        heartbeatIntervalMs: 60_000,
        afterStateRead: async () => {
          if (!blockTransaction) return;
          entered.resolve();
          await resume.promise;
        }
      }
    });
    blockTransaction = true;
    const transaction = runtime.grantStore.revoke("missing", new Date().toISOString());
    await entered.promise;
    const state = JSON.parse(await fs.readFile(fixture.statePath, "utf8")) as {
      revision: number;
    };
    state.revision += 1;
    await fs.writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    resume.resolve();
    await expect(transaction).rejects.toThrow("revision changed");
  });

  it("recovers the same reserved grant after restart without consuming the policy budget twice", async () => {
    const fixture = await createFixture(1);
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const first = await runtime.authority.requestExactDecision({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: proposalFor(evaluationContext("reserved-restart")),
      context: evaluationContext("reserved-restart")
    });
    if (first.effect !== "allow") throw new Error("expected delegated grant");

    const restarted = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const recovered = await restarted.authority.requestExactDecision({
      authorityHandle: restarted.authority.authorityHandle,
      proposal: proposalFor(evaluationContext("reserved-restart")),
      context: evaluationContext("reserved-restart")
    });
    expect(recovered).toMatchObject({
      effect: "allow",
      authorization: { authorizationId: first.authorization.authorizationId }
    });
    await expect(
      restarted.authority.requestExactDecision({
        authorityHandle: restarted.authority.authorityHandle,
        proposal: proposalFor(evaluationContext("different-operation")),
        context: evaluationContext("different-operation")
      })
    ).resolves.toMatchObject({ effect: "deny", code: "POLICY_BUDGET_EXHAUSTED" });
  });

  it("revokes outstanding delegated grants when the trusted policy rotates", async () => {
    const fixture = await createFixture();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const decision = await runtime.authority.requestExactDecision({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: proposalFor(evaluationContext("rotation-digest")),
      context: evaluationContext("rotation-digest")
    });
    if (decision.effect !== "allow") throw new Error("expected delegated grant");
    await expect(runtime.grantStore.issue(legacyGrantFor(decision.authorization))).rejects.toThrow("audit-only");

    const rotatedConfig: LocalL3AuthorityConfig = {
      ...fixture.config,
      policy: { ...fixture.config.policy, policyId: "policy-local-rotated" }
    };
    await installLocalL3AuthorityConfig({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      config: rotatedConfig
    });
    const rotated = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    await expect(rotated.grantStore.get(decision.authorization.authorizationId)).resolves.toBeNull();
  });

  it("fails closed when persisted authority state is corrupted", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.statePath, "{\"schemaVersion\":1,\"revision\":0}\n", {
      encoding: "utf8",
      mode: 0o600
    });
    await expect(
      loadLocalL3AuthorityRuntime({
        configPath: fixture.configPath,
        workspaceRoot: fixture.workspaceRoot,
        routeledgerRoot: fixture.workspaceRoot,
        hostKind: "generic",
        subjectId: "mcp-user"
      })
    ).rejects.toThrow("cannot be trusted");
  });

  it("atomically migrates v1 grants to revoked audit records and tombstones every reserved authority", async () => {
    const fixture = await createFixture(2);
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const reserved = await runtime.authority.requestExactDecision({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: proposalFor(evaluationContext("legacy-reserved")),
      context: evaluationContext("legacy-reserved")
    });
    const issued = await runtime.authority.requestExactDecision({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: proposalFor(evaluationContext("legacy-issued")),
      context: evaluationContext("legacy-issued")
    });
    if (reserved.effect !== "allow" || issued.effect !== "allow") {
      throw new Error("expected legacy grants");
    }
    await expect(runtime.grantStore.issue(legacyGrantFor(issued.authorization))).rejects.toThrow("audit-only");
    const current = JSON.parse(await fs.readFile(fixture.statePath, "utf8")) as Record<string, unknown>;
    const legacy: Record<string, unknown> = { ...current, schemaVersion: 1 };
    delete legacy.legacyTombstones;
    delete legacy.exactStore;
    legacy.reservedGrants = {
      [reserved.authorization.authorizationId]: legacyGrantFor(reserved.authorization)
    };
    legacy.grants = {
      [issued.authorization.authorizationId]: legacyGrantFor(issued.authorization)
    };
    await fs.writeFile(fixture.statePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const migratedText = await fs.readFile(fixture.statePath, "utf8");
    const migrated = JSON.parse(migratedText) as {
      schemaVersion: number;
      reservedGrants: Record<string, unknown>;
      grants: Record<string, { status: string; revokedAt?: string }>;
      legacyTombstones: Record<string, { reason: string }>;
    };
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.reservedGrants).toEqual({});
    expect(migrated.grants[issued.authorization.authorizationId]).toMatchObject({
      status: "revoked",
      revokedAt: expect.any(String)
    });
    expect(migrated.legacyTombstones).toMatchObject({
      [`reserved_grant:${reserved.authorization.authorizationId}`]: { reason: "legacy_reauthorization_required" },
      [`grant:${issued.authorization.authorizationId}`]: { reason: "legacy_reauthorization_required" }
    });

    await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    expect(await fs.readFile(fixture.statePath, "utf8")).toBe(migratedText);
  });

  it("recovers an abandoned state lock before applying a trusted mutation", async () => {
    const fixture = await createFixture();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const lockPath = `${fixture.statePath}.lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    const stale = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, stale, stale);
    await expect(runtime.grantStore.revoke("missing", new Date().toISOString())).resolves.toBeNull();
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads the trusted authority through the real stdio runtime without elicitation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-local-l3-stdio-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const authorityRoot = path.join(root, "authority");
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(authorityRoot, { recursive: true, mode: 0o700 });
    const bootstrap = createRegistry(workspaceRoot);
    const initialized = await bootstrap.invoke("init_project", {
      name: "Local authority stdio",
      contentLocale: "en",
      expectedRouteLedgerRoot: workspaceRoot
    });
    const projectId = (initialized.data as { project: { id: string } }).project.id;
    const proposalResponse = await bootstrap.invoke("create_version", {
      projectId,
      title: "V1",
      initialTodos: [],
      expectedRouteLedgerRoot: workspaceRoot
    });
    const pendingOperationId = (proposalResponse.error!.details as { pendingOperationId: string })
      .pendingOperationId;
    const recommended = await bootstrap.invoke("recommend_l3_authorization_policy", {
      projectId
    });
    const routeledgerRootDigest = (
      recommended.data as { policy: { binding: { routeledgerRootDigest: string } } }
    ).policy.binding.routeledgerRootDigest;
    bootstrap.close();

    const configPath = path.join(authorityRoot, "authority.json");
    const statePath = path.join(authorityRoot, "state.json");
    const config: LocalL3AuthorityConfig = {
      schemaVersion: 1,
      authorityId: "stdio-authority",
      statePath,
      grantTtlSeconds: 300,
      policy: {
        schemaVersion: 1,
        policyId: "stdio-policy",
        mode: "delegated",
        binding: {
          projectId,
          routeledgerRootDigest,
          subjectId: "mcp-user",
          hostKind: "generic"
        },
        defaultEffect: "prompt",
        rules: [
          {
            id: "allow-create",
            effect: "allow",
            actions: ["create_version"],
            conditions: {
              gateMustPass: true,
              expiresAt: "2099-01-01T00:00:00.000Z",
              maxUses: 1
            }
          }
        ],
        alwaysPrompt: []
      }
    };
    await installLocalL3AuthorityConfig({
      configPath,
      workspaceRoot,
      routeledgerRoot: workspaceRoot,
      config
    });
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath,
      workspaceRoot,
      routeledgerRoot: workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    let failCanonicalSave = true;
    const interruptedRegistry = createRouteLedgerMcpRegistry({
      workspaceRoot,
      routeledgerRoot: workspaceRoot,
      sqliteReadModel: "disabled",
      hostProfile: "generic",
      runtimeProfile: "json-only",
      storageTestHooks: {
        afterWriteLockAcquired: () => {
          if (failCanonicalSave) {
            failCanonicalSave = false;
            throw new Error("injected post-receipt canonical save interruption");
          }
        }
      },
      l3Authorization: {
        grantStore: runtime.grantStore,
        exactStore: runtime.exactStore,
        delegatedAuthority: runtime.authority,
        interaction: {
          requestAuthorization: async () => {
            throw new Error("host prompt must not be used");
          }
        },
        sessionId: "interrupted-session"
      }
    });
    const interrupted = await interruptedRegistry.invoke("approve_l3_operation", {
      projectId,
      pendingOperationId,
      expectedRouteLedgerRoot: workspaceRoot
    });
    expect(interrupted.ok).toBe(false);
    interruptedRegistry.close();

    const abandonedLockMetadataPath = path.join(
      workspaceRoot,
      ".routeledger",
      ".write-lock",
      "metadata.json"
    );
    const abandonedLockMetadata = JSON.parse(
      await fs.readFile(abandonedLockMetadataPath, "utf8")
    ) as { updatedAt: string };
    abandonedLockMetadata.updatedAt = "2000-01-01T00:00:00.000Z";
    await fs.writeFile(
      abandonedLockMetadataPath,
      `${JSON.stringify(abandonedLockMetadata, null, 2)}\n`,
      "utf8"
    );

    const recoveredRuntime = await loadLocalL3AuthorityRuntime({
      configPath,
      workspaceRoot,
      routeledgerRoot: workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const output: string[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      }
    });
    const lines = [
      {
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "untrusted-self-report", version: "1.0.0" }
        }
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: "approve",
        method: "tools/call",
        params: {
          name: "approve_l3_operation",
          arguments: {
            projectId,
            pendingOperationId,
            expectedRouteLedgerRoot: workspaceRoot
          }
        }
      }
    ].map((message) => `${JSON.stringify(message)}\n`);
    await runRouteLedgerStdioServer({
      workspaceRoot,
      workspaceRootSource: "explicit_arg",
      routeledgerRoot: workspaceRoot,
      sqliteReadModel: "disabled",
      hostProfile: "generic",
      runtimeProfile: "json-only",
      l3Authorization: {
        grantStore: recoveredRuntime.grantStore,
        exactStore: recoveredRuntime.exactStore,
        delegatedAuthority: recoveredRuntime.authority
      },
      input: Readable.from(lines),
      output: writable
    });
    const messages = output
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const approve = messages.find((message) => message.id === "approve") as {
      result: { structuredContent: { data?: { approvalSource: string } } };
    };
    if (approve.result.structuredContent.data === undefined) {
      throw new Error(JSON.stringify(approve, null, 2));
    }
    expect(approve.result.structuredContent.data.approvalSource).toBe("delegated_policy");
  });
});
