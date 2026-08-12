import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  digestL3AuthorizationProfile,
  type L3AuthorityBindingIdentityV2,
  type L3AuthorizationProfileV2
} from "@routeledger/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildLocalL3AuthorityBindingIdentity,
  buildLocalL3AuthorityBindingKey,
  installLocalL3AuthorizationProfile,
  loadLocalL3AuthorityProfileRegistry,
  type LocalL3AuthorityBindingInput
} from "../local-l3-authority-registry.js";

const roots: string[] = [];

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
};

const createFixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-l3-registry-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const routeledgerRoot = path.join(root, "routeledger-data");
  const registryRoot = path.join(root, "host", "registry");
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(routeledgerRoot, { recursive: true });
  await fs.mkdir(path.dirname(registryRoot), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(registryRoot), 0o700);
  const binding: LocalL3AuthorityBindingInput = {
    projectId: "project-1",
    workspaceRoot,
    routeledgerRoot,
    subjectId: "local-user",
    hostKind: "codex",
    trustedClientId: "codex-desktop"
  };
  return { root, workspaceRoot, routeledgerRoot, registryRoot, binding };
};

const createProfile = (
  binding: L3AuthorityBindingIdentityV2,
  overrides: Partial<Omit<L3AuthorizationProfileV2, "profileDigest" | "binding">> = {}
): L3AuthorizationProfileV2 => {
  const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
    schemaVersion: 3,
    profileId: "profile-1",
    status: "active",
    binding,
    mode: "interactive",
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy: null,
    limits: { maxAuthorizationTtlSeconds: 300 },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides
  };
  return { ...base, profileDigest: digestL3AuthorizationProfile(base) };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local L3 authority profile registry", () => {
  it("installs and resolves a profile by a canonical bound identity", async () => {
    const fixture = await createFixture();
    const identity = await buildLocalL3AuthorityBindingIdentity(fixture.binding);
    const profile = createProfile(identity);
    const installed = await installLocalL3AuthorizationProfile({
      registryRoot: fixture.registryRoot,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.routeledgerRoot,
      binding: fixture.binding,
      profile
    });
    expect(installed.bindingKey).toBe(buildLocalL3AuthorityBindingKey(identity));

    const registry = await loadLocalL3AuthorityProfileRegistry({
      registryRoot: fixture.registryRoot,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.routeledgerRoot
    });
    await expect(registry.bind(fixture.binding)).resolves.toEqual(installed);
    await expect(
      registry.bind({ ...fixture.binding, projectId: "project-without-profile" })
    ).resolves.toBeNull();
  });

  it("migrates a trusted v2 profile to v3 with epoch rotation and exact-only limits", async () => {
    const fixture = await createFixture();
    const identity = await buildLocalL3AuthorityBindingIdentity(fixture.binding);
    const installed = await installLocalL3AuthorizationProfile({
      registryRoot: fixture.registryRoot,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.routeledgerRoot,
      binding: fixture.binding,
      profile: createProfile(identity)
    });
    const legacyBase = {
      schemaVersion: 2,
      profileId: "profile-legacy",
      status: "active",
      binding: identity,
      mode: "interactive",
      modeEpoch: 4,
      profileRevision: 7,
      delegatedPolicy: null,
      limits: { maxGrantTtlSeconds: 600, maxGrantUses: 16 },
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z"
    };
    const effective = {
      schemaVersion: legacyBase.schemaVersion,
      profileId: legacyBase.profileId,
      status: legacyBase.status,
      binding: legacyBase.binding,
      mode: legacyBase.mode,
      modeEpoch: legacyBase.modeEpoch,
      delegatedPolicy: legacyBase.delegatedPolicy,
      limits: legacyBase.limits
    };
    const legacy = {
      ...legacyBase,
      profileDigest: crypto.createHash("sha256")
        .update(JSON.stringify(canonicalize(effective)))
        .digest("hex")
    };
    const profilePath = path.join(
      fixture.registryRoot,
      "bindings",
      installed.bindingKey,
      "profile.json"
    );
    await fs.writeFile(profilePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

    const registry = await loadLocalL3AuthorityProfileRegistry({
      registryRoot: fixture.registryRoot,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.routeledgerRoot
    });
    const migrated = await registry.bind(fixture.binding);
    expect(migrated?.profile).toMatchObject({
      schemaVersion: 3,
      modeEpoch: 5,
      profileRevision: 8,
      limits: { maxAuthorizationTtlSeconds: 600 }
    });
    const persisted = JSON.parse(await fs.readFile(profilePath, "utf8")) as Record<string, unknown>;
    expect(persisted.schemaVersion).toBe(3);
    expect(JSON.stringify(persisted)).not.toContain("maxGrantUses");
    expect(JSON.stringify(persisted)).not.toContain("maxGrantTtlSeconds");
  });

  it("derives the same root digests from equivalent physical path spellings", async () => {
    const fixture = await createFixture();
    const workspaceLink = path.join(fixture.root, "workspace-link");
    await fs.symlink(fixture.workspaceRoot, workspaceLink);
    const direct = await buildLocalL3AuthorityBindingIdentity(fixture.binding);
    const throughLink = await buildLocalL3AuthorityBindingIdentity({
      ...fixture.binding,
      workspaceRoot: workspaceLink
    });
    expect(throughLink.workspaceRootDigest).toBe(direct.workspaceRootDigest);
    expect(buildLocalL3AuthorityBindingKey(throughLink)).toBe(buildLocalL3AuthorityBindingKey(direct));
  });

  it("rejects registry roots inside the Agent-writable workspace and symlink registry roots", async () => {
    const fixture = await createFixture();
    const identity = await buildLocalL3AuthorityBindingIdentity(fixture.binding);
    const profile = createProfile(identity);
    await expect(
      installLocalL3AuthorizationProfile({
        registryRoot: path.join(fixture.workspaceRoot, "authority"),
        workspaceRoot: fixture.workspaceRoot,
        routeledgerRoot: fixture.routeledgerRoot,
        binding: fixture.binding,
        profile
      })
    ).rejects.toThrow("outside the workspace");

    await fs.mkdir(fixture.registryRoot, { mode: 0o700 });
    const registryLink = path.join(fixture.root, "registry-link");
    await fs.symlink(fixture.registryRoot, registryLink);
    await expect(
      loadLocalL3AuthorityProfileRegistry({
        registryRoot: registryLink,
        workspaceRoot: fixture.workspaceRoot,
        routeledgerRoot: fixture.routeledgerRoot
      })
    ).rejects.toThrow("not a symlink");
  });

  it("requires compare-and-swap and an exact revision increment for profile replacement", async () => {
    const fixture = await createFixture();
    const identity = await buildLocalL3AuthorityBindingIdentity(fixture.binding);
    const first = createProfile(identity);
    await installLocalL3AuthorizationProfile({
      registryRoot: fixture.registryRoot,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.routeledgerRoot,
      binding: fixture.binding,
      profile: first
    });
    const replacement = createProfile(identity, {
      profileRevision: 2,
      modeEpoch: 2,
      status: "disabled",
      updatedAt: "2026-08-11T00:01:00.000Z"
    });
    await expect(
      installLocalL3AuthorizationProfile({
        registryRoot: fixture.registryRoot,
        workspaceRoot: fixture.workspaceRoot,
        routeledgerRoot: fixture.routeledgerRoot,
        binding: fixture.binding,
        profile: replacement
      })
    ).rejects.toThrow("expectedProfileRevision");
    await expect(
      installLocalL3AuthorizationProfile({
        registryRoot: fixture.registryRoot,
        workspaceRoot: fixture.workspaceRoot,
        routeledgerRoot: fixture.routeledgerRoot,
        binding: fixture.binding,
        profile: replacement,
        expectedProfileRevision: 1
      })
    ).resolves.toMatchObject({ profile: { profileRevision: 2, modeEpoch: 2 } });
  });

  it("rejects profile widening without epoch rotation and serializes concurrent CAS", async () => {
    const fixture = await createFixture();
    const identity = await buildLocalL3AuthorityBindingIdentity(fixture.binding);
    const first = createProfile(identity);
    await installLocalL3AuthorizationProfile({
      registryRoot: fixture.registryRoot,
      workspaceRoot: fixture.workspaceRoot,
      routeledgerRoot: fixture.routeledgerRoot,
      binding: fixture.binding,
      profile: first
    });
    const missingRotation = createProfile(identity, {
      profileRevision: 2,
      status: "disabled",
      updatedAt: "2026-08-11T00:01:00.000Z"
    });
    await expect(
      installLocalL3AuthorizationProfile({
        registryRoot: fixture.registryRoot,
        workspaceRoot: fixture.workspaceRoot,
        routeledgerRoot: fixture.routeledgerRoot,
        binding: fixture.binding,
        profile: missingRotation,
        expectedProfileRevision: 1
      })
    ).rejects.toThrow("increment modeEpoch");

    const replacement = createProfile(identity, {
      profileRevision: 2,
      modeEpoch: 2,
      status: "disabled",
      updatedAt: "2026-08-11T00:01:00.000Z"
    });
    const attempts = await Promise.allSettled([
      installLocalL3AuthorizationProfile({
        registryRoot: fixture.registryRoot,
        workspaceRoot: fixture.workspaceRoot,
        routeledgerRoot: fixture.routeledgerRoot,
        binding: fixture.binding,
        profile: replacement,
        expectedProfileRevision: 1
      }),
      installLocalL3AuthorizationProfile({
        registryRoot: fixture.registryRoot,
        workspaceRoot: fixture.workspaceRoot,
        routeledgerRoot: fixture.routeledgerRoot,
        binding: fixture.binding,
        profile: replacement,
        expectedProfileRevision: 1
      })
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });
});
