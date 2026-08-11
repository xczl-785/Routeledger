import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
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
import { createRouteLedgerMcpRegistry, MCP_PROTOCOL_VERSION } from "../index.js";
import {
  createRouteLedgerStdioServer,
  type JsonRpcMessage
} from "../stdio-server.js";

const roots: string[] = [];

const call = (
  server: ReturnType<typeof createRouteLedgerStdioServer>,
  id: string,
  name: string,
  args: Record<string, unknown>
) => server.handleMessage({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args }
});

const initializeProject = async (projectRoot: string, name: string): Promise<string> => {
  const registry = createRouteLedgerMcpRegistry({
    workspaceRoot: projectRoot,
    routeledgerRoot: projectRoot,
    sqliteReadModel: "disabled"
  });
  try {
    const response = await registry.invoke("init_project", {
      name,
      contentLocale: "en",
      expectedRouteLedgerRoot: projectRoot
    });
    if (!response.ok) throw new Error(response.error?.message ?? "project initialization failed");
    return (response.data as { project: { id: string } }).project.id;
  } finally {
    registry.close();
  }
};

const installProfile = async (
  registryRoot: string,
  binding: LocalL3AuthorityBindingInput,
  profileId: string
): Promise<L3AuthorizationProfileV2> => {
  const identity = await buildLocalL3AuthorityBindingIdentity(binding);
  const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
    schemaVersion: 2,
    profileId,
    status: "active",
    binding: identity,
    mode: "preauthorized",
    modeEpoch: 1,
    profileRevision: 1,
    delegatedPolicy: null,
    limits: { maxGrantTtlSeconds: 300, maxGrantUses: 5 },
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z"
  };
  const profile = { ...base, profileDigest: digestL3AuthorizationProfile(base) };
  await installLocalL3AuthorizationProfile({
    registryRoot,
    workspaceRoot: binding.workspaceRoot,
    routeledgerRoot: binding.routeledgerRoot,
    binding,
    profile
  });
  return profile;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("stdio host authority broker binding", () => {
  it("selects from canonical runtime identity and drops the old profile during A to B rebind", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-l3-broker-stdio-"));
    roots.push(root);
    const projectA = path.join(root, "project-a");
    const projectB = path.join(root, "project-b");
    const registryRoot = path.join(root, "host", "registry");
    await fs.mkdir(projectA);
    await fs.mkdir(projectB);
    await fs.mkdir(path.dirname(registryRoot), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(registryRoot), 0o700);
    const projectAId = await initializeProject(projectA, "Project A");
    const projectBId = await initializeProject(projectB, "Project B");
    const common = {
      subjectId: "mcp-user",
      hostKind: "codex",
      trustedClientId: "codex-desktop"
    } as const;
    const bindingA = {
      ...common,
      projectId: projectAId,
      workspaceRoot: projectA,
      routeledgerRoot: projectA
    };
    const bindingB = {
      ...common,
      projectId: projectBId,
      workspaceRoot: projectB,
      routeledgerRoot: projectB
    };
    await installProfile(registryRoot, bindingA, "profile-a");
    await installProfile(registryRoot, bindingB, "profile-b");

    const observedProfiles: Array<string | null> = [];
    const outbound: JsonRpcMessage[] = [];
    const server = createRouteLedgerStdioServer({
      hostProfile: "codex",
      sqliteReadModel: "disabled",
      l3AuthorityBroker: createLocalL3AuthorityBroker({
        registryRoot,
        hostKind: "codex",
        subjectId: "mcp-user",
        trustedClientId: "codex-desktop"
      }),
      registryFactory: (options) => {
        observedProfiles.push(options.l3Authorization?.profile?.profileId ?? null);
        return createRouteLedgerMcpRegistry(options);
      },
      sendMessage: (message) => outbound.push(message)
    });
    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: "self-reported-codex", version: "1" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const rootsA = outbound.at(-1);
      if (rootsA === undefined || !("id" in rootsA)) throw new Error("expected roots/list request");
      await server.handleMessage({
        jsonrpc: "2.0",
        id: rootsA.id,
        result: { roots: [{ uri: pathToFileURL(projectA).href }] }
      });

      const contextA = await call(server, "context-a", "get_runtime_context", {});
      expect(contextA).toMatchObject({ result: { structuredContent: { ok: true } } });
      expect(observedProfiles.at(-1)).toBe("profile-a");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "notifications/roots/list_changed"
      });
      const rootsB = outbound.at(-1);
      if (rootsB === undefined || !("id" in rootsB)) throw new Error("expected roots/list request");
      await server.handleMessage({
        jsonrpc: "2.0",
        id: rootsB.id,
        result: { roots: [{ uri: pathToFileURL(projectB).href }] }
      });
      expect(observedProfiles.at(-1)).toBeNull();

      const contextB = await call(server, "context-b", "get_runtime_context", {});
      expect(contextB).toMatchObject({ result: { structuredContent: { ok: true } } });
      expect(observedProfiles.at(-1)).toBe("profile-b");
      expect(observedProfiles).toContain(null);
    } finally {
      server.close();
    }
  });
});
