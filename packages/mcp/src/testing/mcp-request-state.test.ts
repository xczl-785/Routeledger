import { describe, expect, it } from "vitest";

import {
  digestMcpToolArguments,
  sealMcpRequestState,
  verifyMcpRequestState
} from "../mcp-request-state.js";
import {
  parseMcpAuthorizationDecisionResponse,
  readMcpAuthorizationDecision
} from "../mcp-decision-input.js";

const secret = "routeledger-request-state-test-secret-32";
const args = { projectId: "project-1", idempotencyKey: "key-1" };
const state = {
  schemaVersion: 2 as const,
  toolName: "execute_route_change" as const,
  argumentsDigest: digestMcpToolArguments(args),
  binding: {
    proposalId: "proposal-1",
    projectId: "project-1",
    routeledgerRootDigest: "root-1",
    actionType: "start_version" as const,
    targetId: "version-1",
    operationDigest: "operation-1"
  },
  issuedAt: "2026-08-11T00:00:00.000Z",
  expiresAt: "2026-08-11T00:10:00.000Z"
};

describe("MCP request-state integrity", () => {
  it("parses only approve-only exact decisions", () => {
    expect(parseMcpAuthorizationDecisionResponse({
      action: "accept",
      content: { approve: true }
    })).toEqual({ action: "accept", content: { approve: true } });
    expect(() => parseMcpAuthorizationDecisionResponse({
      action: "accept",
      content: { approve: true, scope: "operation" }
    })).toThrow("only approve");
    expect(() => readMcpAuthorizationDecision({
      routeledger_l3_decision: {
        action: "accept",
        content: { approve: true, extra: true }
      }
    })).toThrow("only approve");
  });

  it("survives key-order changes while remaining bound to exact arguments", () => {
    const token = sealMcpRequestState(state, secret);
    expect(
      verifyMcpRequestState(token, secret, {
        toolName: "execute_route_change",
        argumentsDigest: digestMcpToolArguments({ idempotencyKey: "key-1", projectId: "project-1" }),
        now: new Date("2026-08-11T00:05:00.000Z")
      })
    ).toEqual(state);
    expect(() =>
      verifyMcpRequestState(token, secret, {
        toolName: "execute_route_change",
        argumentsDigest: digestMcpToolArguments({ ...args, idempotencyKey: "key-2" }),
        now: new Date("2026-08-11T00:05:00.000Z")
      })
    ).toThrow("does not match");
  });

  it("fails closed after expiry and with another process secret", () => {
    const token = sealMcpRequestState(state, secret);
    expect(() =>
      verifyMcpRequestState(token, secret, {
        toolName: "execute_route_change",
        argumentsDigest: state.argumentsDigest,
        now: new Date("2026-08-11T00:10:00.000Z")
      })
    ).toThrow("expired");
    expect(() =>
      verifyMcpRequestState(token, "another-request-state-secret-32-characters", {
        toolName: "execute_route_change",
        argumentsDigest: state.argumentsDigest,
        now: new Date("2026-08-11T00:05:00.000Z")
      })
    ).toThrow("integrity");
  });

  it("rejects future-issued and inverted request-state windows", () => {
    expect(() =>
      verifyMcpRequestState(
        sealMcpRequestState(
          { ...state, issuedAt: "2026-08-11T00:06:00.000Z" },
          secret
        ),
        secret,
        {
          toolName: "execute_route_change",
          argumentsDigest: state.argumentsDigest,
          now: new Date("2026-08-11T00:05:00.000Z")
        }
      )
    ).toThrow("timestamps");
    expect(() =>
      verifyMcpRequestState(
        sealMcpRequestState(
          { ...state, expiresAt: state.issuedAt },
          secret
        ),
        secret,
        {
          toolName: "execute_route_change",
          argumentsDigest: state.argumentsDigest,
          now: new Date("2026-08-11T00:05:00.000Z")
        }
      )
    ).toThrow("timestamps");
  });
});
