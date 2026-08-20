import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryExactAuthorizationStore } from "../../packages/core/src/index.js";
import {
  readRouteLedgerJsonDocuments,
  type RouteLedgerJsonDocument
} from "../../packages/json/src/index.js";
import { createRouteLedgerMcpRegistry } from "../../packages/mcp/src/index.js";
import { resolveDefaultRouteLedgerDataDir } from "../../packages/mcp/src/workspace-config.js";

interface FootprintDelta {
  addedFiles: number;
  modifiedFiles: number;
  removedFiles: number;
  addedBytes: number;
  netBytes: number;
  changedFilesByArea: Record<string, number>;
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const areaForPath = (documentPath: string): string => {
  const segments = documentPath.replaceAll("\\", "/").split("/");
  const firstSegment = segments[0] === ".routeledger" ? segments[1] : segments[0];
  return firstSegment?.endsWith(".json") ? "root" : (firstSegment ?? "root");
};

const measureDelta = (
  before: RouteLedgerJsonDocument[],
  after: RouteLedgerJsonDocument[]
): FootprintDelta => {
  const beforeByPath = new Map(before.map((document) => [document.path, document.content]));
  const afterByPath = new Map(after.map((document) => [document.path, document.content]));
  const changedPaths = new Set<string>();
  let addedFiles = 0;
  let modifiedFiles = 0;
  let removedFiles = 0;
  let addedBytes = 0;
  let netBytes = 0;

  for (const [documentPath, content] of afterByPath) {
    const previous = beforeByPath.get(documentPath);
    if (previous === undefined) {
      addedFiles += 1;
      addedBytes += byteLength(content);
      netBytes += byteLength(content);
      changedPaths.add(documentPath);
    } else if (previous !== content) {
      modifiedFiles += 1;
      netBytes += byteLength(content) - byteLength(previous);
      changedPaths.add(documentPath);
    }
  }
  for (const [documentPath, content] of beforeByPath) {
    if (afterByPath.has(documentPath)) continue;
    removedFiles += 1;
    netBytes -= byteLength(content);
    changedPaths.add(documentPath);
  }

  const changedFilesByArea = [...changedPaths]
    .map(areaForPath)
    .sort()
    .reduce<Record<string, number>>((counts, area) => {
      counts[area] = (counts[area] ?? 0) + 1;
      return counts;
    }, {});

  return { addedFiles, modifiedFiles, removedFiles, addedBytes, netBytes, changedFilesByArea };
};

const requireData = <T>(
  response: Awaited<ReturnType<ReturnType<typeof createRouteLedgerMcpRegistry>["invoke"]>>
): T => {
  if (!response.ok) throw new Error(`${response.error?.code}: ${response.error?.message}`);
  return response.data as T;
};

const main = async (): Promise<void> => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-footprint-"));
  const registry = createRouteLedgerMcpRegistry({
    workspaceRoot: projectRoot,
    routeledgerRoot: projectRoot,
    runtimeProfile: "json-only",
    l3Authorization: {
      exactStore: new MemoryExactAuthorizationStore(),
      interaction: {
        requestAuthorization: async () => ({ action: "accept", content: { approve: true } })
      },
      trustedClientId: "audit-footprint"
    }
  });

  try {
    const initialized = requireData<{
      project: { id: string };
      firstVersion: { id: string };
    }>(
      await registry.invoke("configure_project", {
        operation: "initialize",
        name: "Audit footprint benchmark",
        contentLocale: "en",
        firstVersion: {
          title: "Initial Version",
          description: "Audit footprint baseline",
          initialTodos: []
        },
        expectedRouteLedgerRoot: projectRoot
      })
    );
    const dataRoot = resolveDefaultRouteLedgerDataDir(projectRoot);
    const capture = () => readRouteLedgerJsonDocuments(dataRoot);
    const measurements: Record<string, FootprintDelta> = {};

    let before = await capture();
    const createdTodo = requireData<{ todo: { id: string } }>(
      await registry.invoke("manage_todo", {
        operation: "create",
        projectId: initialized.project.id,
        versionId: initialized.firstVersion.id,
        title: "Measure Todo write",
        idempotencyKey: "footprint-create-todo",
        expectedRouteLedgerRoot: projectRoot
      })
    );
    let after = await capture();
    measurements.createTodo = measureDelta(before, after);

    before = after;
    requireData(
      await registry.invoke("manage_todo", {
        operation: "close",
        projectId: initialized.project.id,
        todoId: createdTodo.todo.id,
        reason: "benchmark",
        note: "Measure close footprint",
        idempotencyKey: "footprint-close-todo",
        expectedRouteLedgerRoot: projectRoot
      })
    );
    after = await capture();
    measurements.closeTodo = measureDelta(before, after);

    before = after;
    const proposal = requireData<{ pendingOperationId: string }>(
      await registry.invoke("propose_version_structure_change", {
        operation: "propose_version_creation",
        projectId: initialized.project.id,
        title: "Measured successor",
        expectedRouteLedgerRoot: projectRoot
      })
    );
    after = await capture();
    measurements.createVersionProposal = measureDelta(before, after);

    before = after;
    const approval = requireData<{ id: string }>(
      await registry.invoke("execute_route_change", {
        operation: "approve_l3_operation",
        projectId: initialized.project.id,
        pendingOperationId: proposal.pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      })
    );
    after = await capture();
    measurements.approveVersionProposal = measureDelta(before, after);

    before = after;
    requireData(
      await registry.invoke("execute_route_change", {
        operation: "commit_l3_operation",
        projectId: initialized.project.id,
        pendingOperationId: proposal.pendingOperationId,
        approvalArtifactId: approval.id,
        expectedRouteLedgerRoot: projectRoot
      })
    );
    after = await capture();
    measurements.commitVersionProposal = measureDelta(before, after);

    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, measurements }, null, 2)}\n`);
  } finally {
    registry.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
