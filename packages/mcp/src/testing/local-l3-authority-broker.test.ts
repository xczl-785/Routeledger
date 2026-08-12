import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildBalancedL3AuthorizationPolicy,
  digestL3AuthorizationProfile,
  type L3AuthorizationProfileV2
} from "@routeledger/core";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalL3AuthorityBroker } from "../local-l3-authority-broker.js";
import {
  buildLocalL3AuthorityBindingIdentity,
  installLocalL3AuthorizationProfile,
  type LocalL3AuthorityBindingInput
} from "../local-l3-authority-registry.js";

const roots: string[] = [];

const profileFor = async (
  binding: LocalL3AuthorityBindingInput,
  profileId: string
): Promise<L3AuthorizationProfileV2> => {
  const identity = await buildLocalL3AuthorityBindingIdentity(binding);
  const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
    schemaVersion: 3,
    profileId,
    status: "active",
    binding: identity,
    mode: "preauthorized",
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy: null,
    limits: { maxAuthorizationTtlSeconds: 300 },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
  return { ...base, profileDigest: digestL3AuthorizationProfile(base) };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local L3 authority broker", () => {
  it("selects isolated profile and grant stores for separate project bindings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-l3-broker-"));
    roots.push(root);
    const registryRoot = path.join(root, "host", "registry");
    await fs.mkdir(path.dirname(registryRoot), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(registryRoot), 0o700);
    const bindings = await Promise.all(
      ["a", "b"].map(async (suffix) => {
        const workspaceRoot = path.join(root, `workspace-${suffix}`);
        const routeledgerRoot = path.join(root, `routeledger-${suffix}`);
        await fs.mkdir(workspaceRoot);
        await fs.mkdir(routeledgerRoot);
        return {
          projectId: `project-${suffix}`,
          workspaceRoot,
          routeledgerRoot,
          subjectId: "local-user",
          hostKind: "codex",
          trustedClientId: "codex-desktop"
        } satisfies LocalL3AuthorityBindingInput;
      })
    );
    for (const [index, binding] of bindings.entries()) {
      const profile = await profileFor(binding, `profile-${index}`);
      await installLocalL3AuthorizationProfile({
        registryRoot,
        workspaceRoot: binding.workspaceRoot,
        routeledgerRoot: binding.routeledgerRoot,
        binding,
        profile
      });
    }
    const broker = createLocalL3AuthorityBroker({
      registryRoot,
      hostKind: "codex",
      subjectId: "local-user",
      trustedClientId: "codex-desktop"
    });
    const [boundA, boundB] = await Promise.all(
      bindings.map((binding) => broker.bind({
        projectId: binding.projectId,
        workspaceRoot: binding.workspaceRoot,
        routeledgerRoot: binding.routeledgerRoot
      }))
    );
    expect(boundA?.profile.profileId).toBe("profile-0");
    expect(boundB?.profile.profileId).toBe("profile-1");

    await expect(boundA!.exactStore.get("authorization-from-other-binding")).resolves.toBeNull();
    await expect(boundB!.exactStore.get("authorization-from-other-binding")).resolves.toBeNull();
  });

  it("fails closed when the verified project has no installed profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-l3-broker-empty-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const routeledgerRoot = path.join(root, "routeledger");
    const registryRoot = path.join(root, "host", "registry");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(routeledgerRoot);
    await fs.mkdir(registryRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(registryRoot, "registry-v2.json"),
      `${JSON.stringify({ schemaVersion: 2, registryId: "registry-empty", createdAt: "2026-08-11T00:00:00.000Z" })}\n`,
      { mode: 0o600 }
    );
    const broker = createLocalL3AuthorityBroker({
      registryRoot,
      hostKind: "codex",
      subjectId: "local-user",
      trustedClientId: "codex-desktop"
    });
    await expect(
      broker.bind({ projectId: "missing", workspaceRoot, routeledgerRoot })
    ).resolves.toBeNull();
  });

  it("requires a trusted host decision for finite preauthorization and revokes access atomically", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-l3-broker-preauth-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const routeledgerRoot = path.join(root, "routeledger");
    const registryRoot = path.join(root, "host", "registry");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(routeledgerRoot);
    await fs.mkdir(path.dirname(registryRoot), { recursive: true, mode: 0o700 });
    const binding = {
      projectId: "project-preauth",
      workspaceRoot,
      routeledgerRoot,
      subjectId: "local-user",
      hostKind: "codex",
      trustedClientId: "codex-desktop"
    } satisfies LocalL3AuthorityBindingInput;
    const profile = await profileFor(binding, "profile-preauth");
    await installLocalL3AuthorizationProfile({
      registryRoot,
      workspaceRoot,
      routeledgerRoot,
      binding,
      profile
    });
    const bindingRequest = { projectId: binding.projectId, workspaceRoot, routeledgerRoot };
    const standingPolicy = buildBalancedL3AuthorizationPolicy({
      policyId: "standing-policy-1",
      projectId: profile.binding.projectId,
      routeledgerRootDigest: profile.binding.routeledgerRootDigest,
      currentVersionId: "version-1",
      routeVersionIds: ["version-1", "version-2"],
      expiresAt: "2026-08-12T00:00:00.000Z",
      decisionBudget: 2,
      subjectId: profile.binding.subjectId,
      hostKind: profile.binding.hostKind,
      clientId: profile.binding.trustedClientId ?? undefined
    });
    const untrusted = createLocalL3AuthorityBroker({
      registryRoot,
      hostKind: "codex",
      subjectId: "local-user",
      trustedClientId: "codex-desktop"
    });
    await expect(
      untrusted.configureStandingPolicy({
        binding: bindingRequest,
        policy: standingPolicy,
        expectedProfileRevision: 1
      })
    ).rejects.toThrow("trusted host user-interaction adapter");

    const decisions: Array<Record<string, unknown>> = [];
    const broker = createLocalL3AuthorityBroker({
      registryRoot,
      hostKind: "codex",
      subjectId: "local-user",
      trustedClientId: "codex-desktop",
      trustedHostInteraction: {
        requestDecision: async (request) => {
          decisions.push(request);
          return {
            kind: "trusted_host_user",
            decisionId: "host-decision-1",
            decidedAt: "2026-08-11T00:00:00.000Z"
          };
        }
      }
    });
    const configured = await broker.configureStandingPolicy({
      binding: bindingRequest,
      policy: standingPolicy,
      expectedProfileRevision: 1
    });
    expect(decisions).toHaveLength(1);
    expect(configured.profile).toMatchObject({
      mode: "preauthorized",
      modeEpoch: 2,
      profileRevision: 2,
      delegatedPolicy: { policyId: "standing-policy-1" }
    });
    expect(configured.delegatedAuthority).toBeDefined();

    const revoked = await broker.revokeAccess({
      binding: bindingRequest,
      expectedProfileRevision: 2
    });
    expect(revoked.profile).toMatchObject({ status: "disabled", modeEpoch: 3, profileRevision: 3 });
    await expect(
      broker.revokeAccess({ binding: bindingRequest, expectedProfileRevision: 2 })
    ).rejects.toThrow("revision conflict");
  });
});
