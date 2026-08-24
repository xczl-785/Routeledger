import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRouteLedgerMcpRegistry,
  type RouteLedgerMcpRegistry,
  type ToolResponse
} from "../index.js";

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const requireData = <T>(response: ToolResponse): T => {
  if (!response.ok) throw new Error(`${response.error?.code}: ${response.error?.message}`);
  return response.data as T;
};

describe("agent response footprint", () => {
  let projectRoot: string;
  let registry: RouteLedgerMcpRegistry;
  let projectId: string;
  let versionId: string;

  beforeAll(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-response-test-"));
    registry = createRouteLedgerMcpRegistry({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot,
      runtimeProfile: "json-only",
      sqliteReadModel: "disabled",
      interactionProfile: "agent_only"
    });
    const initialized = requireData<{
      project: { id: string };
      firstVersion: { id: string };
    }>(
      await registry.invoke("configure_project", {
        operation: "initialize",
        name: "Response footprint test",
        contentLocale: "zh",
        firstVersion: {
          title: "Initial Version",
          description: "Representative ready project.",
          initialTodos: []
        },
        expectedRouteLedgerRoot: projectRoot
      })
    );
    projectId = initialized.project.id;
    versionId = initialized.firstVersion.id;
    await registry.invoke("set_version_state", {
      operation: "prepare",
      projectId,
      versionId: initialized.firstVersion.id,
      expectedRouteLedgerRoot: projectRoot
    });
  });

  afterAll(() => {
    registry.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("keeps representative compact reads within budget and never larger than standard", async () => {
    const cases = [
      {
        tool: "inspect_runtime",
        input: { operation: "runtime" },
        hardLimit: 1_536
      },
      {
        tool: "inspect_route_progress",
        input: { operation: "next_action", projectId },
        hardLimit: 1_536
      },
      {
        tool: "inspect_route_progress",
        input: { operation: "get_current_context", projectId },
        hardLimit: 2_048
      },
      {
        tool: "inspect_versions",
        input: { operation: "list_versions", projectId },
        hardLimit: 1_536
      },
      {
        tool: "inspect_l3_route_operations",
        input: { operation: "list_l3_proposals", projectId },
        hardLimit: 768
      }
    ];

    for (const testCase of cases) {
      const compact = await registry.invoke(testCase.tool, {
        ...testCase.input,
        detail: "compact"
      });
      const standard = await registry.invoke(testCase.tool, {
        ...testCase.input,
        detail: "standard"
      });

      expect(jsonBytes(compact), `${testCase.tool}:${testCase.input.operation}`).toBeLessThanOrEqual(
        testCase.hardLimit
      );
      expect(jsonBytes(compact), `${testCase.tool}:${testCase.input.operation}`).toBeLessThanOrEqual(
        jsonBytes(standard)
      );
    }
  });

  it("keeps an ordinary write round trip within the R1 compact budget", async () => {
    const created = await registry.invoke("manage_todo", {
      operation: "create",
      projectId,
      versionId,
      title: "Measure compact Todo receipt",
      description: "This description should not be repeated across the compact receipt.",
      idempotencyKey: "response-footprint-create",
      expectedRouteLedgerRoot: projectRoot,
      detail: "compact"
    });
    const todoId = (created.data as { todo: { id: string } }).todo.id;

    expect(created).toMatchObject({
      ok: true,
      data: {
        todo: { id: todoId, status: "wait" },
        idempotency: { replayed: false }
      }
    });
    expect(jsonBytes(created)).toBeLessThanOrEqual(1_536);

    const closed = await registry.invoke("manage_todo", {
      operation: "close",
      projectId,
      todoId,
      reason: "measurement complete",
      note: "Close the isolated benchmark Todo.",
      idempotencyKey: "response-footprint-close",
      expectedRouteLedgerRoot: projectRoot,
      detail: "compact"
    });

    expect(closed).toMatchObject({
      ok: true,
      data: {
        todo: { id: todoId, status: "closed" },
        idempotency: { replayed: false }
      }
    });
    expect(jsonBytes(closed)).toBeLessThanOrEqual(1_536);
  });
});
