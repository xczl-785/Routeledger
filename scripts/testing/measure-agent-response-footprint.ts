import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRouteLedgerMcpRegistry, type ToolResponse } from "../../packages/mcp/src/index.js";

type Detail = "compact" | "standard";

interface Measurement {
  operation: string;
  detail: Detail;
  businessBytes: number;
  structuredEnvelopeBytes: number;
  textContentBytes: number;
  legacyTransportBytes: number;
  dataSections?: Record<string, number>;
  metaSections?: Record<string, number>;
}

const bytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

const textBytes = (value: string): number => Buffer.byteLength(value, "utf8");

const sectionBytes = (value: unknown): Record<string, number> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, child]) => [key, bytes(child)] as const)
          .sort((left, right) => right[1] - left[1])
      )
    : undefined;

const measure = (
  operation: string,
  detail: Detail,
  response: ToolResponse
): Measurement => {
  const structuredEnvelope = {
    ok: response.ok,
    ...(response.data === undefined ? {} : { data: response.data }),
    ...(response.error === undefined ? {} : { error: response.error }),
    ...(response.meta === undefined ? {} : { meta: response.meta })
  };
  const text = JSON.stringify(structuredEnvelope, null, 2);
  const legacyTransport = {
    content: [{ type: "text", text }],
    structuredContent: structuredEnvelope,
    ...(response.ok ? {} : { isError: true })
  };

  return {
    operation,
    detail,
    businessBytes: bytes(response.data ?? response.error ?? null),
    structuredEnvelopeBytes: bytes(structuredEnvelope),
    textContentBytes: textBytes(text),
    legacyTransportBytes: bytes(legacyTransport),
    ...(sectionBytes(response.data) === undefined
      ? {}
      : { dataSections: sectionBytes(response.data) }),
    ...(sectionBytes(response.meta) === undefined
      ? {}
      : { metaSections: sectionBytes(response.meta) })
  };
};

const requireData = <T>(response: ToolResponse): T => {
  if (!response.ok) {
    throw new Error(`${response.error?.code ?? "UNKNOWN"}: ${response.error?.message ?? "failed"}`);
  }
  return response.data as T;
};

const main = async (): Promise<void> => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-agent-response-"));
  const registry = createRouteLedgerMcpRegistry({
    workspaceRoot: projectRoot,
    routeledgerRoot: projectRoot,
    runtimeProfile: "json-only",
    sqliteReadModel: "disabled",
    interactionProfile: "agent_only"
  });

  try {
    const initialized = requireData<{
      project: { id: string };
      firstVersion: { id: string };
    }>(
      await registry.invoke("configure_project", {
        operation: "initialize",
        name: "Agent response footprint",
        contentLocale: "zh",
        firstVersion: {
          title: "Initial Version",
          description: "Measure routine Agent response sizes.",
          initialTodos: []
        },
        expectedRouteLedgerRoot: projectRoot
      })
    );

    await registry.invoke("set_version_state", {
      operation: "prepare",
      projectId: initialized.project.id,
      versionId: initialized.firstVersion.id,
      expectedRouteLedgerRoot: projectRoot
    });

    const measurements: Measurement[] = [];
    const readCases = [
      {
        label: "runtime",
        tool: "inspect_runtime",
        input: { operation: "runtime" }
      },
      {
        label: "current_context",
        tool: "inspect_route_progress",
        input: {
          operation: "get_current_context",
          projectId: initialized.project.id
        }
      },
      {
        label: "next_action",
        tool: "inspect_route_progress",
        input: { operation: "next_action", projectId: initialized.project.id }
      },
      {
        label: "versions",
        tool: "inspect_versions",
        input: { operation: "list_versions", projectId: initialized.project.id }
      },
      {
        label: "l3_proposals",
        tool: "inspect_l3_route_operations",
        input: { operation: "list_l3_proposals", projectId: initialized.project.id }
      }
    ] as const;

    for (const readCase of readCases) {
      for (const detail of ["compact", "standard"] as const) {
        const response = await registry.invoke(readCase.tool, {
          ...readCase.input,
          detail
        });
        measurements.push(measure(readCase.label, detail, response));
      }
    }

    const byOperation = Object.fromEntries(
      readCases.map(({ label }) => {
        const compact = measurements.find(
          (item) => item.operation === label && item.detail === "compact"
        );
        const standard = measurements.find(
          (item) => item.operation === label && item.detail === "standard"
        );
        return [
          label,
          {
            compact,
            standard,
            structuredRatio:
              compact !== undefined && standard !== undefined
                ? Number(
                    (compact.structuredEnvelopeBytes / standard.structuredEnvelopeBytes).toFixed(3)
                  )
                : null
          }
        ];
      })
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          scope: "isolated_json_only_ready_project",
          byOperation
        },
        null,
        2
      )}\n`
    );
  } finally {
    registry.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
