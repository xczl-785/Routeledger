import path from "node:path";
import fs from "node:fs/promises";

import {
  digestL3AuthorizationProfile,
  type L3AuthorizationProfileV2
} from "@routeledger/core";
import {
  buildLocalL3AuthorityBindingIdentity,
  installLocalL3AuthorizationProfile
} from "../../packages/mcp/src/local-l3-authority-registry.js";
import { createRouteLedgerMcpRegistry } from "../../packages/mcp/src/index.js";

const main = async (): Promise<void> => {
  const [workspaceArgument, registryArgument] = process.argv.slice(2);
  if (!workspaceArgument || !registryArgument) {
    throw new Error("Usage: tsx setup-codex-l3-normal-turn-fixture.ts <workspace> <registry>");
  }
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
  const binding = await buildLocalL3AuthorityBindingIdentity({
    projectId,
    workspaceRoot,
    routeledgerRoot: workspaceRoot,
    subjectId: "routeledger-approver",
    hostKind: "codex",
    trustedClientId: "codex-local-host"
  });
  const now = new Date().toISOString();
  const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
    schemaVersion: 2,
    profileId: "profile-codex-normal-turn",
    status: "active",
    binding,
    mode: "interactive",
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy: null,
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
  process.stdout.write(`${JSON.stringify({ projectId, pendingOperationId, profileDigest: profile.profileDigest })}\n`);
  } finally {
    registry.close();
  }
};

void main();
