import { describe, expect, it } from "vitest";

import { runMcpToolCallPipeline } from "../mcp-tool-call-pipeline.js";

type Response = { kind: "success" | "tool-error" | "json-rpc-error" };

describe("MCP tools/call pipeline", () => {
  it("runs successful calls through the fixed transport lifecycle", async () => {
    const stages: string[] = [];

    const response = await runMcpToolCallPipeline<string, string, string, string, string, Response>({
      validate: async () => {
        stages.push("validate");
        return { kind: "continue", value: "validated" };
      },
      bind: async () => {
        stages.push("bind");
        return { kind: "continue", value: "bound" };
      },
      authorize: async () => {
        stages.push("authorize");
        return { kind: "continue", value: "authorized" };
      },
      execute: async () => {
        stages.push("execute");
        return { kind: "continue", value: "executed" };
      },
      rebind: async () => {
        stages.push("rebind");
        return { kind: "continue", value: "rebound" };
      },
      project: async () => {
        stages.push("project");
        return { kind: "success" };
      },
      mapError: () => ({ kind: "json-rpc-error" })
    });

    expect(stages).toEqual(["validate", "bind", "authorize", "execute", "rebind", "project"]);
    expect(response).toEqual({ kind: "success" });
  });

  it("keeps tool-level errors in the normal response projection path", async () => {
    const stages: string[] = [];

    const response = await runMcpToolCallPipeline<string, string, string, string, string, Response>({
      validate: async () => {
        stages.push("validate");
        return { kind: "continue", value: "validated" };
      },
      bind: async () => {
        stages.push("bind");
        return { kind: "continue", value: "bound" };
      },
      authorize: async () => {
        stages.push("authorize");
        return { kind: "continue", value: "authorized" };
      },
      execute: async () => {
        stages.push("execute");
        return { kind: "continue", value: "tool-error" };
      },
      rebind: async () => {
        stages.push("rebind");
        return { kind: "continue", value: "rebound" };
      },
      project: async () => {
        stages.push("project");
        return { kind: "tool-error" };
      },
      mapError: () => ({ kind: "json-rpc-error" })
    });

    expect(stages).toEqual(["validate", "bind", "authorize", "execute", "rebind", "project"]);
    expect(response).toEqual({ kind: "tool-error" });
  });

  it("maps unexpected stage exceptions to a JSON-RPC response and stops execution", async () => {
    const stages: string[] = [];

    const response = await runMcpToolCallPipeline<string, string, string, string, string, Response>({
      validate: async () => {
        stages.push("validate");
        return { kind: "continue", value: "validated" };
      },
      bind: async () => {
        stages.push("bind");
        return { kind: "continue", value: "bound" };
      },
      authorize: async () => {
        stages.push("authorize");
        return { kind: "continue", value: "authorized" };
      },
      execute: async () => {
        stages.push("execute");
        throw new Error("registry unavailable");
      },
      rebind: async () => {
        stages.push("rebind");
        return { kind: "continue", value: "rebound" };
      },
      project: async () => {
        stages.push("project");
        return { kind: "success" };
      },
      mapError: (error) => {
        stages.push(`map-error:${error instanceof Error ? error.message : String(error)}`);
        return { kind: "json-rpc-error" };
      }
    });

    expect(stages).toEqual(["validate", "bind", "authorize", "execute", "map-error:registry unavailable"]);
    expect(response).toEqual({ kind: "json-rpc-error" });
  });
});
