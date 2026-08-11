import { describe, expect, it } from "vitest";

import {
  digestMcpToolArguments,
  sealMcpRequestState,
  verifyMcpRequestState
} from "../mcp-request-state.js";

const secret = "routeledger-request-state-test-secret-32";
const args = { projectId: "project-1", idempotencyKey: "key-1" };
const state = {
  schemaVersion: 1 as const,
  toolName: "execute_l3_operation" as const,
  argumentsDigest: digestMcpToolArguments(args),
  pendingOperationId: "proposal-1",
  issuedAt: "2026-08-11T00:00:00.000Z",
  expiresAt: "2026-08-11T00:10:00.000Z"
};

describe("MCP request-state integrity", () => {
  it("survives key-order changes while remaining bound to exact arguments", () => {
    const token = sealMcpRequestState(state, secret);
    expect(
      verifyMcpRequestState(token, secret, {
        toolName: "execute_l3_operation",
        argumentsDigest: digestMcpToolArguments({ idempotencyKey: "key-1", projectId: "project-1" }),
        now: new Date("2026-08-11T00:05:00.000Z")
      })
    ).toEqual(state);
    expect(() =>
      verifyMcpRequestState(token, secret, {
        toolName: "execute_l3_operation",
        argumentsDigest: digestMcpToolArguments({ ...args, idempotencyKey: "key-2" }),
        now: new Date("2026-08-11T00:05:00.000Z")
      })
    ).toThrow("does not match");
  });

  it("fails closed after expiry and with another process secret", () => {
    const token = sealMcpRequestState(state, secret);
    expect(() =>
      verifyMcpRequestState(token, secret, {
        toolName: "execute_l3_operation",
        argumentsDigest: state.argumentsDigest,
        now: new Date("2026-08-11T00:10:00.000Z")
      })
    ).toThrow("expired");
    expect(() =>
      verifyMcpRequestState(token, "another-request-state-secret-32-characters", {
        toolName: "execute_l3_operation",
        argumentsDigest: state.argumentsDigest,
        now: new Date("2026-08-11T00:05:00.000Z")
      })
    ).toThrow("integrity");
  });
});
