import path from "node:path";
import fs from "node:fs/promises";

import {
  digestL3AuthorizationProfile,
  type L3AuthorizationMode,
  type L3AuthorizationPolicy,
  type L3AuthorizationProfileV2
} from "@routeledger/core";
import { createLocalL3AuthorityBroker } from "../../packages/mcp/src/local-l3-authority-broker.js";
import {
  buildLocalL3AuthorityBindingIdentity,
  installLocalL3AuthorizationProfile
} from "../../packages/mcp/src/local-l3-authority-registry.js";
import { createRouteLedgerMcpRegistry } from "../../packages/mcp/src/index.js";

const main = async (): Promise<void> => {
  const [workspaceArgument, registryArgument, modeArgument = "interactive"] = process.argv.slice(2);
  if (!workspaceArgument || !registryArgument) {
    throw new Error(
      "Usage: tsx setup-codex-l3-normal-turn-fixture.ts <workspace> <registry> [interactive|delegated|preauthorized]"
    );
  }
  if (!(["interactive", "delegated", "preauthorized"] as string[]).includes(modeArgument)) {
    throw new Error("Fixture authorization mode is invalid.");
  }
  const mode = modeArgument as L3AuthorizationMode;
  const workspaceRoot = path.resolve(workspaceArgument);
  const registryRoot = path.resolve(registryArgument);
  await fs.mkdir(path.dirname(registryRoot), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(registryRoot), 0o700);
  const registry = createRouteLedgerMcpRegistry({
    workspaceRoot,
    routeledgerRoot: workspaceRoot,
    sqliteReadModel: "disabled",
    hostProfile: "codex"
  });

  try {
  const initialized = await registry.invoke("init_project", {
    name: "Codex L3 normal-turn fixture",
    contentLocale: "en",
    expectedRouteLedgerRoot: workspaceRoot
  });
  if (!initialized.ok) throw new Error(initialized.error?.message ?? "fixture init failed");
  const projectId = (initialized.data as { project: { id: string } }).project.id;
  const proposed = await registry.invoke("create_version", {
    projectId,
    title: "Version 1",
    expectedRouteLedgerRoot: workspaceRoot
  });
  const pendingOperationId = proposed.error?.details?.pendingOperationId;
  if (typeof pendingOperationId !== "string") {
    throw new Error("Fixture create_version did not produce an L3 pending operation.");
  }
  const proposalResult = await registry.invoke("get_l3_proposal", {
    projectId,
    pendingOperationId
  });
  if (!proposalResult.ok) throw new Error(proposalResult.error?.message ?? "proposal lookup failed");
  const proposal = proposalResult.data as {
    actionType: "create_version";
    targetId: string;
    digest: { value: string };
  };
  const binding = await buildLocalL3AuthorityBindingIdentity({
    projectId,
    workspaceRoot,
    routeledgerRoot: workspaceRoot,
    subjectId: "routeledger-approver",
    hostKind: "codex",
    trustedClientId: "codex-local-host"
  });
  const now = new Date().toISOString();
  const delegatedPolicy: L3AuthorizationPolicy | null =
    mode === "delegated"
      ? {
          schemaVersion: 1,
          policyId: "policy-codex-normal-turn",
          mode: "delegated",
          binding: {
            projectId,
            routeledgerRootDigest: binding.routeledgerRootDigest,
            subjectId: "routeledger-approver",
            hostKind: "codex",
            clientId: "codex-local-host"
          },
          defaultEffect: "deny",
          rules: [
            {
              id: "allow-exact-fixture-operation",
              effect: "allow",
              actions: [proposal.actionType],
              resources: { targetIds: [proposal.targetId] },
              conditions: {
                gateMustPass: true,
                allowedTargetRelations: ["other"],
                expiresAt: new Date(Date.now() + 300_000).toISOString(),
                maxUses: 1
              }
            }
          ],
          alwaysPrompt: []
        }
      : null;
  const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
    schemaVersion: 2,
    profileId: "profile-codex-normal-turn",
    status: "active",
    binding,
    mode,
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy,
    limits: { maxGrantTtlSeconds: 300, maxGrantUses: 1 },
    createdAt: now,
    updatedAt: now
  };
  const profile = { ...base, profileDigest: digestL3AuthorizationProfile(base) };
  await installLocalL3AuthorizationProfile({
    registryRoot,
    workspaceRoot,
    routeledgerRoot: workspaceRoot,
    binding: {
      projectId,
      workspaceRoot,
      routeledgerRoot: workspaceRoot,
      subjectId: "routeledger-approver",
      hostKind: "codex",
      trustedClientId: "codex-local-host"
    },
    profile
  });
  let preauthorizationGrantId: string | null = null;
  if (mode === "preauthorized") {
    const broker = createLocalL3AuthorityBroker({
      registryRoot,
      hostKind: "codex",
      subjectId: "routeledger-approver",
      trustedClientId: "codex-local-host",
      trustedHostInteraction: {
        requestDecision: async () => ({
          kind: "trusted_host_user",
          decisionId: "fixture-trusted-host-decision",
          decidedAt: new Date().toISOString()
        })
      }
    });
    const grant = await broker.issuePreauthorization({
      binding: { projectId, workspaceRoot, routeledgerRoot: workspaceRoot },
      scope: "time_window",
      allowedActions: [proposal.actionType],
      allowedTargetIds: [proposal.targetId],
      ttlSeconds: 300,
      maxUses: 1
    });
    preauthorizationGrantId = grant.id;
  }
  process.stdout.write(
    `${JSON.stringify({
      projectId,
      pendingOperationId,
      actionType: proposal.actionType,
      targetId: proposal.targetId,
      operationDigest: proposal.digest.value,
      mode,
      profileDigest: profile.profileDigest,
      preauthorizationGrantId
    })}\n`
  );
  } finally {
    registry.close();
  }
};

void main();
