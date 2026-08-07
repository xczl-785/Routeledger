import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRouteLedgerMcpRegistry } from "../src/index.js";

type ToolResponse = Awaited<
  ReturnType<ReturnType<typeof createRouteLedgerMcpRegistry>["invoke"]>
>;

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message
) => {
  if (!condition) {
    throw new Error(message);
  }
};

const expectOk = (response: ToolResponse, label: string) => {
  if (!response.ok) {
    throw new Error(
      `${label} failed: ${response.error?.code ?? "UNKNOWN"} ${response.error?.message ?? ""}`.trim()
    );
  }

  return response.data as Record<string, any>;
};

const waitFor = async (
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs: number
): Promise<void> => {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
};

const main = async (): Promise<void> => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-ui-source-smoke-"));
  const workspaceRoot = path.join(tmpRoot, "workspace");
  const routeledgerRoot = path.join(workspaceRoot, "project");
  const stateRoot = path.join(tmpRoot, "state");

  process.env.XDG_STATE_HOME = stateRoot;

  await fs.mkdir(routeledgerRoot, { recursive: true });

  const registry = createRouteLedgerMcpRegistry({
    workspaceRoot,
    routeledgerRoot
  });

  let launchedPid: number | null = null;

  try {
    const initProject = await registry.invoke("init_project", {
      name: "Mission Control Source Smoke",
      expectedRouteLedgerRoot: routeledgerRoot
    });
    const initialized = expectOk(initProject, "init_project");
    const projectId = initialized.project.id as string;

    const statusBeforeResponse = await registry.invoke("get_mission_control_status", {});
    const statusBefore = expectOk(statusBeforeResponse, "get_mission_control_status before open");
    assert(statusBefore.matchingInstance === null, "status before open should not find a running instance");
    assert(
      typeof statusBefore.registryPath === "string" &&
        statusBefore.registryPath.startsWith(stateRoot),
      "status should use the temp XDG registry path"
    );

    const firstOpenResponse = await registry.invoke("open_mission_control", {});
    const firstOpen = expectOk(firstOpenResponse, "open_mission_control first");
    launchedPid = firstOpen.pid as number;

    assert(firstOpen.reused === false, "first open_mission_control call should launch a new instance");
    assert(firstOpen.projectId === projectId, "open_mission_control should return the initialized projectId");
    assert(typeof firstOpen.url === "string" && firstOpen.url.startsWith("http://127.0.0.1:"), "open_mission_control should return a localhost URL");
    assert(Number.isInteger(firstOpen.port) && firstOpen.port > 0, "open_mission_control should return a listen(0) port");
    assert(
      typeof firstOpen.workspaceRoot === "string" && firstOpen.workspaceRoot.length > 0,
      "open_mission_control should return the resolved workspaceRoot"
    );
    assert(
      typeof firstOpen.routeledgerRoot === "string" && firstOpen.routeledgerRoot.length > 0,
      "open_mission_control should return the resolved routeledgerRoot"
    );

    const resolvedWorkspaceRoot = firstOpen.workspaceRoot;
    const resolvedRouteLedgerRoot = firstOpen.routeledgerRoot;

    const healthResponse = await fetch(`${firstOpen.url}/api/health`, {
      headers: {
        accept: "application/json"
      }
    });
    assert(healthResponse.ok, "Mission Control /api/health should return 200");
    const healthPayload = (await healthResponse.json()) as Record<string, any>;
    assert(healthPayload.projectId === projectId, "Mission Control health should report the active projectId");

    const stateResponse = await fetch(`${firstOpen.url}/api/state`, {
      headers: {
        accept: "application/json"
      }
    });
    assert(stateResponse.ok, "Mission Control /api/state should return 200");
    const statePayload = (await stateResponse.json()) as Record<string, any>;
    assert(
      statePayload.identity?.projectId === projectId,
      "Mission Control state should expose the same projectId"
    );
    assert(
      statePayload.binding?.workspaceRoot === resolvedWorkspaceRoot,
      "Mission Control state should expose the MCP-resolved workspaceRoot"
    );
    assert(
      statePayload.binding?.workspaceRootSource === "explicit_arg",
      "Mission Control state should expose workspaceRootSource=explicit_arg for source launcher input"
    );
    assert(
      statePayload.binding?.workspaceConfigPath ===
        path.join(resolvedWorkspaceRoot, ".routeledger", "config.json"),
      "Mission Control state should expose the workspace config path under the MCP-resolved workspaceRoot"
    );
    assert(
      statePayload.binding?.routeledgerRoot === resolvedRouteLedgerRoot,
      "Mission Control state should expose the MCP-resolved routeledgerRoot"
    );

    const secondOpenResponse = await registry.invoke("open_mission_control", {});
    const secondOpen = expectOk(secondOpenResponse, "open_mission_control second");
    assert(secondOpen.reused === true, "second open_mission_control call should reuse the running instance");
    assert(secondOpen.url === firstOpen.url, "reused Mission Control instance should keep the same URL");
    assert(secondOpen.port === firstOpen.port, "reused Mission Control instance should keep the same port");

    const statusAfterResponse = await registry.invoke("get_mission_control_status", {});
    const statusAfter = expectOk(statusAfterResponse, "get_mission_control_status after open");
    assert(
      statusAfter.matchingInstance?.url === firstOpen.url,
      "status after open should report the healthy matching Mission Control instance"
    );
    assert(
      Array.isArray(statusAfter.healthyInstances) &&
        statusAfter.healthyInstances.some(
          (entry: Record<string, any>) => entry.url === firstOpen.url && entry.projectId === projectId
        ),
      "status after open should include the healthy instance"
    );

    console.log(
      `Mission Control source smoke passed: ${firstOpen.url} projectId=${projectId} port=${firstOpen.port}`
    );
  } finally {
    registry.close();

    if (launchedPid !== null) {
      try {
        process.kill(launchedPid, "SIGTERM");
      } catch {
        launchedPid = null;
      }
    }

    if (launchedPid !== null) {
      await waitFor(async () => {
        try {
          process.kill(launchedPid!, 0);
          return false;
        } catch {
          return true;
        }
      }, 5000, 100);
    }

    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
};

await main();
