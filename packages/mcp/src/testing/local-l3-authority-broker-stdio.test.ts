import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
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
  runRouteLedgerStdioServer,
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
  it("rejects an approver identity that conflicts with the trusted broker subject", () => {
    expect(() =>
      createRouteLedgerStdioServer({
        hostProfile: "codex",
        sqliteReadModel: "disabled",
        approver: { id: "other-subject" },
        l3AuthorityBroker: createLocalL3AuthorityBroker({
          registryRoot: "/unused-in-construction",
          hostKind: "codex",
          subjectId: "trusted-subject",
          trustedClientId: "trusted-client"
        }),
        sendMessage: () => undefined
      })
    ).toThrow("Configured approver identity must match the host authority broker subject.");
  });

  it("forwards the host broker through the real stdio runner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-l3-broker-runner-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const registryRoot = path.join(root, "host", "registry");
    await fs.mkdir(projectRoot);
    await fs.mkdir(path.dirname(registryRoot), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(registryRoot), 0o700);
    const projectId = await initializeProject(projectRoot, "Runner project");
    const binding = {
      projectId,
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      subjectId: "mcp-user",
      hostKind: "codex",
      trustedClientId: "codex-desktop"
    } as const;
    await installProfile(registryRoot, binding, "profile-runner");

    const requests = [
      {
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "self-reported-codex", version: "1" }
        }
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: "status",
        method: "tools/call",
        params: { name: "get_l3_authorization_status", arguments: {} }
      }
    ];
    let output = "";
    await runRouteLedgerStdioServer({
      workspaceRoot: projectRoot,
      workspaceRootSource: "explicit_arg",
      routeledgerRoot: projectRoot,
      hostProfile: "codex",
      sqliteReadModel: "disabled",
      l3AuthorityBroker: createLocalL3AuthorityBroker({
        registryRoot,
        hostKind: "codex",
        subjectId: "mcp-user",
        trustedClientId: "codex-desktop"
      }),
      input: Readable.from(requests.map((request) => `${JSON.stringify(request)}\n`)),
      output: new Writable({
        write(chunk, _encoding, callback) {
          output += chunk.toString();
          callback();
        }
      })
    });
    const status = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((response) => response.id === "status") as {
        result?: { structuredContent?: unknown };
      } | undefined;
    expect(status?.result?.structuredContent).toMatchObject({
      ok: true,
      data: {
        controlPlane: "host_authority_broker_v2",
        authorizationBackend: "host_authority_broker_v2",
        profile: { mode: "preauthorized" }
      }
    });
  });

  it("selects the host profile after an explicit session activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-l3-broker-activation-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const bootstrapRoot = path.join(root, "bootstrap");
    const registryRoot = path.join(root, "host", "registry");
    await fs.mkdir(projectRoot);
    await fs.mkdir(bootstrapRoot);
    await fs.mkdir(path.dirname(registryRoot), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(registryRoot), 0o700);
    const projectId = await initializeProject(projectRoot, "Activated project");
    const binding = {
      projectId,
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      subjectId: "mcp-user",
      hostKind: "codex",
      trustedClientId: "codex-desktop"
    } as const;
    await installProfile(registryRoot, binding, "profile-activated");

    const observedProfiles: Array<string | null> = [];
    const previousCwd = process.cwd();
    process.chdir(bootstrapRoot);
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
      sendMessage: () => undefined
    });
    try {
      await server.handleMessage({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "self-reported-codex", version: "1" }
        }
      });
      await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
      const activation = await call(server, "activate", "activate_routeledger_binding", {
        workspaceRoot: projectRoot,
        routeledgerRoot: projectRoot
      });
      expect(activation).toMatchObject({ result: { structuredContent: { ok: true } } });

      const status = await call(server, "status", "get_l3_authorization_status", {});
      expect(status).toMatchObject({
        result: {
          structuredContent: {
            ok: true,
            data: {
              controlPlane: "host_authority_broker_v2",
              profile: { mode: "preauthorized" }
            }
          }
        }
      });
      expect(observedProfiles.at(-1)).toBe("profile-activated");
    } finally {
      process.chdir(previousCwd);
      server.close();
    }
  });

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
