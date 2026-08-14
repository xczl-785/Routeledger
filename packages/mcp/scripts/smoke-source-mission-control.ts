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
  const secondWorkspaceRoot = path.join(tmpRoot, "workspace-two");
  const secondRouteledgerRoot = path.join(secondWorkspaceRoot, "project-two");
  const stateRoot = path.join(tmpRoot, "state");

  process.env.XDG_STATE_HOME = stateRoot;
  process.env.ROUTELEDGER_UI_IDLE_TIMEOUT_MS = "750";

  await Promise.all([
    fs.mkdir(routeledgerRoot, { recursive: true }),
    fs.mkdir(secondRouteledgerRoot, { recursive: true })
  ]);

  const registry = createRouteLedgerMcpRegistry({
    workspaceRoot,
    routeledgerRoot
  });
  const secondRegistry = createRouteLedgerMcpRegistry({
    workspaceRoot: secondWorkspaceRoot,
    routeledgerRoot: secondRouteledgerRoot
  });

  let launchedPid: number | null = null;
  let idleExitError: Error | null = null;

  try {
    const initProject = await registry.invoke("init_project", {
      name: "Mission Control Source Smoke",
      contentLocale: "en",
      expectedRouteLedgerRoot: routeledgerRoot
    });
    const initialized = expectOk(initProject, "init_project");
    const projectId = initialized.project.id as string;
    const secondInit = expectOk(await secondRegistry.invoke("init_project", {
      name: "Mission Control Second Project",
      contentLocale: "en",
      expectedRouteLedgerRoot: secondRouteledgerRoot
    }), "second init_project");
    const secondProjectId = secondInit.project.id as string;

    const statusBeforeResponse = await registry.invoke("get_mission_control_status", {});
    const statusBefore = expectOk(statusBeforeResponse, "get_mission_control_status before open");
    assert(statusBefore.hub === null, "status before open should not find a running UI Hub");
    assert(
      typeof statusBefore.registryPath === "string" &&
        statusBefore.registryPath.startsWith(stateRoot),
      "status should use the temp XDG registry path"
    );

    const [firstOpenResponse, crossProjectResponse] = await Promise.all([
      registry.invoke("open_mission_control", {}),
      secondRegistry.invoke("open_mission_control", {})
    ]);
    const firstOpen = expectOk(firstOpenResponse, "open_mission_control first");
    const crossProjectOpen = expectOk(crossProjectResponse, "open_mission_control concurrent second project");
    launchedPid = firstOpen.pid as number;

    assert(
      [firstOpen.reused, crossProjectOpen.reused].filter((value) => value === false).length === 1,
      "concurrent opens should elect exactly one UI Hub launcher"
    );
    assert(firstOpen.pid === crossProjectOpen.pid, "concurrent opens should return one shared UI Hub pid");
    assert(firstOpen.projectId === projectId, "open_mission_control should return the initialized projectId");
    assert(typeof firstOpen.projectKey === "string", "open_mission_control should return a stable project key");
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

    const hubUrl = new URL(firstOpen.url as string).origin;
    const healthResponse = await fetch(`${hubUrl}/api/health`, {
      headers: {
        accept: "application/json"
      }
    });
    assert(healthResponse.ok, "Mission Control /api/health should return 200");
    const healthPayload = (await healthResponse.json()) as Record<string, any>;
    assert(healthPayload.projectCount === 2, "Mission Control health should report both concurrently registered projects");

    const stateResponse = await fetch(`${hubUrl}/api/state?project=${encodeURIComponent(firstOpen.projectKey as string)}`, {
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
    assert(new URL(secondOpen.url as string).origin === hubUrl, "reused Mission Control Hub should keep the same origin");
    assert(secondOpen.port === firstOpen.port, "reused Mission Control instance should keep the same port");

    assert(crossProjectOpen.pid === firstOpen.pid, "second project should share the elected UI Hub process");
    assert(new URL(crossProjectOpen.url as string).origin === hubUrl, "second project should reuse the same UI Hub origin");
    assert(crossProjectOpen.projectId === secondProjectId, "second project should retain its own identity");
    assert(crossProjectOpen.projectKey !== firstOpen.projectKey, "registered projects should have distinct project keys");

    const projectsResponse = await fetch(`${hubUrl}/api/projects`);
    const projectsPayload = (await projectsResponse.json()) as { projects: Array<Record<string, any>> };
    assert(projectsPayload.projects.length === 2, "one UI Hub should expose both explicitly registered projects");
    const secondStateResponse = await fetch(
      `${hubUrl}/api/state?project=${encodeURIComponent(crossProjectOpen.projectKey as string)}`
    );
    const secondState = (await secondStateResponse.json()) as Record<string, any>;
    assert(secondState.identity?.projectId === secondProjectId, "project selection should return the second canonical snapshot");

    const statusAfterResponse = await registry.invoke("get_mission_control_status", {});
    const statusAfter = expectOk(statusAfterResponse, "get_mission_control_status after open");
    assert(
      statusAfter.hub?.url === hubUrl,
      "status after open should report the healthy UI Hub"
    );
    assert(
      Array.isArray(statusAfter.projects) && statusAfter.projects.some(
        (entry: Record<string, any>) => entry.projectId === projectId
      ),
      "status after open should include the registered project"
    );

    console.log(
      `Mission Control source smoke passed: ${firstOpen.url} projectId=${projectId} port=${firstOpen.port}`
    );
  } finally {
    registry.close();
    secondRegistry.close();

    if (launchedPid !== null) {
      try {
        await waitFor(async () => {
          try {
            process.kill(launchedPid!, 0);
            return false;
          } catch {
            return true;
          }
        }, 5000, 100);
      } catch (error) {
        process.kill(launchedPid, "SIGTERM");
        idleExitError = new Error(`UI Hub did not exit after its configured idle timeout: ${String(error)}`);
      }
    }

    await fs.rm(tmpRoot, { recursive: true, force: true });
  }

  if (idleExitError !== null) throw idleExitError;
};

await main();
