import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import {
  buildBalancedL3AuthorizationPolicy,
  MemoryL3AuthorizationGrantStore,
  type L3AuthorizationEvaluationContext,
  type L3AuthorizationGrantStore,
  type L3AuthorizationConsumptionReceipt,
  type L3AuthorizationReceiptBinding
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

  it("persists grants and exact consumption receipts across MCP process reconstruction", async () => {
    const fixture = await createFixture();
    const runtime = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    const context = evaluationContext("digest-1");
    const decision = await runtime.authority.requestGrant({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: {} as never,
      context
    });
    expect(decision.effect).toBe("allow");
    if (decision.effect !== "allow") throw new Error("expected delegated grant");
    await runtime.grantStore.issue(decision.grant);
    const grantContext = {
      audience: "routeledger-core",
      subjectId: "mcp-user",
      projectId: "project-1",
      routeledgerRootDigest: "root-digest",
      actionType: "start_version",
      targetId: "version-2",
      operationDigest: "digest-1",
      now: context.now,
      hostKind: "generic",
      clientId: "trusted-client"
    } as const;
    const binding: L3AuthorizationReceiptBinding = {
      approvalArtifactId: "artifact-1",
      pendingOperationId: "pending-1",
      grantId: decision.grant.id,
      audience: "routeledger-core",
      subjectId: "mcp-user",
      projectId: "project-1",
      routeledgerRootDigest: "root-digest",
      actionType: "start_version",
      targetId: "version-2",
      operationDigest: "digest-1",
      approvalSource: "delegated_policy",
      decisionRef: decision.grant.decisionId,
      approverId: "mcp-user",
      approverType: "user",
      approverDisplayName: "MCP user",
      policyId: decision.grant.policyId,
      policyDigest: decision.grant.policyDigest,
      hostKind: "generic",
      clientId: "trusted-client",
      sessionId: null,
      createdAt: context.now,
      expiresAt: decision.grant.expiresAt
    };
    const consumed = await runtime.grantStore.consumeAndRecordReceipt(
      decision.grant.id,
      grantContext,
      "pending-1",
      (consumption) => ({ ...binding, consumedUse: consumption.consumedUse })
    );
    expect(consumed).toMatchObject({ ok: true, consumedUse: 1, receipt: binding });

    const restarted = await loadLocalL3AuthorityRuntime({
      configPath: fixture.configPath,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.workspaceRoot,
      hostKind: "generic",
      subjectId: "mcp-user"
    });
    await expect(restarted.grantStore.get(decision.grant.id)).resolves.toMatchObject({
      status: "exhausted",
      uses: 1
    });
    await expect(restarted.grantStore.verifyConsumptionReceipt(binding)).resolves.toBe(true);
    await expect(
      restarted.grantStore.verifyConsumptionReceipt({ ...binding, operationDigest: "tampered" })
    ).resolves.toBe(false);
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
    const decision = await runtime.authority.requestGrant({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: {} as never,
      context: evaluationContext("store-contract")
    });
    if (decision.effect !== "allow") throw new Error("expected delegated grant");
    const receipt: L3AuthorizationConsumptionReceipt = {
      approvalArtifactId: "contract-artifact",
      pendingOperationId: "contract-pending",
      grantId: decision.grant.id,
      audience: decision.grant.audience,
      subjectId: decision.grant.subjectId,
      projectId: decision.grant.projectId,
      routeledgerRootDigest: decision.grant.routeledgerRootDigest,
      actionType: "start_version",
      targetId: "version-2",
      operationDigest: "store-contract",
      approvalSource: "delegated_policy",
      decisionRef: decision.grant.decisionId,
      approverId: "mcp-user",
      approverType: "user",
      approverDisplayName: "MCP user",
      policyId: decision.grant.policyId,
      policyDigest: decision.grant.policyDigest,
      hostKind: "generic",
      clientId: "trusted-client",
      sessionId: null,
      createdAt: decision.grant.createdAt,
      expiresAt: decision.grant.expiresAt,
      consumedUse: 1
    };
    const stores: Array<[string, L3AuthorizationGrantStore]> = [
      ["memory", new MemoryL3AuthorizationGrantStore()],
      ["persistent", runtime.grantStore]
    ];
    for (const [name, store] of stores) {
      await store.issue(decision.grant);
      await expect(store.issue(structuredClone(decision.grant)), name).resolves.toBeUndefined();
      await expect(
        store.issue({ ...decision.grant, issuer: "conflicting-issuer" }),
        name
      ).rejects.toThrow("already exists");
      await store.recordConsumptionReceipt(receipt);
      await expect(
        store.recordConsumptionReceipt(structuredClone(receipt)),
        name
      ).resolves.toBeUndefined();
      await expect(
        store.recordConsumptionReceipt({ ...receipt, decisionRef: "conflicting-decision" }),
        name
      ).rejects.toThrow("already exists");
    }
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
        runtime.authority.requestGrant({
          authorityHandle: runtime.authority.authorityHandle,
          proposal: {} as never,
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
    const firstRequest = runtime.authority.requestGrant({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: {} as never,
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
      runtime.authority.requestGrant({
        authorityHandle: runtime.authority.authorityHandle,
        proposal: {} as never,
        context: evaluationContext("competing-transaction")
      })
    ).rejects.toThrow("Timed out waiting");
    resume.resolve();
    await expect(firstRequest).resolves.toMatchObject({ effect: "allow" });
    blockTransaction = false;
    await expect(
      runtime.authority.requestGrant({
        authorityHandle: runtime.authority.authorityHandle,
        proposal: {} as never,
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
    const first = await runtime.authority.requestGrant({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: {} as never,
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
    const recovered = await restarted.authority.requestGrant({
      authorityHandle: restarted.authority.authorityHandle,
      proposal: {} as never,
      context: evaluationContext("reserved-restart")
    });
    expect(recovered).toMatchObject({ effect: "allow", grant: { id: first.grant.id } });
    await expect(
      restarted.authority.requestGrant({
        authorityHandle: restarted.authority.authorityHandle,
        proposal: {} as never,
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
    const decision = await runtime.authority.requestGrant({
      authorityHandle: runtime.authority.authorityHandle,
      proposal: {} as never,
      context: evaluationContext("rotation-digest")
    });
    if (decision.effect !== "allow") throw new Error("expected delegated grant");
    await runtime.grantStore.issue(decision.grant);

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
    await expect(rotated.grantStore.get(decision.grant.id)).resolves.toMatchObject({
      status: "revoked",
      revokedAt: expect.any(String)
    });
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
