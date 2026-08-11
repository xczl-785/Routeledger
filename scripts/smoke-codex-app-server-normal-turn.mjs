#!/usr/bin/env node
/* global setTimeout */

import process from "node:process";

import { spawnCodexAppServerJsonlClient } from "./lib/codex-app-server-jsonl-client.mjs";

const cwd = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_CWD;
const prompt = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_PROMPT;
const expectedTool = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_TOOL;
const expectedInner = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_INNER ?? "none";
const expectedAuthorizationMode = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_AUTH_MODE;
const expectedToolStatus =
  process.env.ROUTELEDGER_CODEX_NORMAL_TURN_TOOL_STATUS ??
  (expectedInner === "none" ? "completed" : "failed");
const expectedResultToken = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_RESULT_TOKEN;
const approvalsReviewer = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_APPROVALS_REVIEWER;
const activateBinding = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_ACTIVATE === "1";
const timeoutMs = Number(process.env.ROUTELEDGER_CODEX_NORMAL_TURN_TIMEOUT_MS ?? 180_000);

if (!cwd || !prompt || !expectedTool) {
  throw new Error(
    "ROUTELEDGER_CODEX_NORMAL_TURN_CWD, ROUTELEDGER_CODEX_NORMAL_TURN_PROMPT, and ROUTELEDGER_CODEX_NORMAL_TURN_TOOL are required."
  );
}
if (!["none", "bare_accept_rejected", "cancel", "auto_review_cancel"].includes(expectedInner)) {
  throw new Error(
    "ROUTELEDGER_CODEX_NORMAL_TURN_INNER must be none, bare_accept_rejected, cancel, or auto_review_cancel."
  );
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("ROUTELEDGER_CODEX_NORMAL_TURN_TIMEOUT_MS must be a positive number.");
}

const client = spawnCodexAppServerJsonlClient({ cwd, defaultTimeoutMs: timeoutMs });
const stderr = [];
client.stderr.on("data", (chunk) => stderr.push(String(chunk)));

const timeline = [];
let innerRequests = 0;
let outerRequests = 0;
client.on("message", (message) => {
  if (
    message?.method === "item/agentMessage/delta" ||
    message?.method === "thread/tokenUsage/updated" ||
    message?.method === "account/rateLimits/updated" ||
    message?.method === "mcpServer/startupStatus/updated"
  ) {
    return;
  }
  const item = message?.params?.item;
  timeline.push({
    method: message?.method ?? null,
    request: Object.hasOwn(message ?? {}, "id"),
    itemType: item?.type ?? null,
    tool: item?.tool ?? item?.toolName ?? null,
    status: item?.status ?? message?.params?.turn?.status ?? null
  });
});

client.onServerRequest("tool/requestUserInput", (params) => {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  const answers = {};
  for (const question of questions) {
    const id = question?.id;
    const options = Array.isArray(question?.options) ? question.options : [];
    const accepted = options.find((option) => /^(accept|approve|allow)$/iu.test(option?.label ?? ""));
    if (typeof id !== "string" || accepted === undefined) {
      throw new Error("The outer tool approval did not expose an explicit Accept/Approve/Allow option.");
    }
    answers[id] = { answers: [accepted.label] };
  }
  return { answers };
});

client.onServerRequest("mcpServer/elicitation/request", async (params, request) => {
  if (params?._meta?.codex_approval_kind === "mcp_tool_call") {
    outerRequests += 1;
    return { action: "accept", content: {} };
  }
  const properties = params?.requestedSchema?.properties;
  const isRouteLedgerAuthorization =
    properties !== null &&
    typeof properties === "object" &&
    Object.hasOwn(properties, "approve") &&
    Object.hasOwn(properties, "scope");
  if (!isRouteLedgerAuthorization) {
    throw new Error(`Unexpected non-RouteLedger MCP elicitation: ${JSON.stringify(params)}`);
  }
  innerRequests += 1;
  if (expectedInner === "none") {
    throw new Error("Unexpected inner RouteLedger elicitation in a no-prompt scenario.");
  }
  if (expectedInner === "auto_review_cancel") {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const resolved = client.messages.some(
      (message) =>
        message?.method === "serverRequest/resolved" &&
        String(message?.params?.requestId) === String(request?.id)
    );
    if (resolved) {
      throw new Error("auto_review resolved the inner RouteLedger authorization request.");
    }
    return { action: "cancel", content: null };
  }
  return expectedInner === "cancel"
    ? { action: "cancel", content: null }
    : {
        action: "accept",
        content: { approve: true, scope: "operation" }
      };
});

try {
  await client.request("initialize", {
    clientInfo: {
      name: "routeledger-normal-turn-smoke",
      title: "RouteLedger normal turn smoke",
      version: "0.1.0"
    },
    capabilities: { mcpServerOpenaiFormElicitation: true }
  });
  client.notify("initialized", {});
  const started = await client.request("thread/start", {
    cwd,
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    serviceName: "routeledger-normal-turn-smoke",
    ...(approvalsReviewer === undefined ? {} : { approvalsReviewer })
  });
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string") throw new Error("Codex app-server returned no thread id.");
  if (activateBinding) {
    const activation = await client.request("mcpServer/tool/call", {
      threadId,
      server: "routeledger",
      tool: "activate_routeledger_binding",
      arguments: { workspaceRoot: cwd, routeledgerRoot: cwd }
    });
    if (activation?.structuredContent?.ok !== true) {
      throw new Error(`RouteLedger setup activation failed: ${JSON.stringify(activation?.structuredContent)}`);
    }
  }
  if (expectedAuthorizationMode !== undefined) {
    const status = await client.request("mcpServer/tool/call", {
      threadId,
      server: "routeledger",
      tool: "get_l3_authorization_status",
      arguments: {}
    });
    const authorization = status?.structuredContent?.data;
    if (
      authorization?.controlPlane !== "host_authority_broker_v2" ||
      authorization?.profile?.mode !== expectedAuthorizationMode
    ) {
      throw new Error(
        `Expected active V3 ${expectedAuthorizationMode} profile, received ${JSON.stringify(authorization)}.`
      );
    }
  }
  const turn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: prompt }]
  });
  const turnId = turn?.turn?.id;
  if (typeof turnId !== "string") throw new Error("Codex app-server returned no turn id.");
  const completed = await client.waitForMessage(
    (message) => message?.method === "turn/completed" && message?.params?.turn?.id === turnId,
    { timeoutMs, description: `turn/completed for ${turnId}` }
  );
  const toolCalls = client.messages
    .filter((message) => message?.method === "item/completed" && message?.params?.item?.type === "mcpToolCall")
    .map((message) => message.params.item)
    .filter((item) => item?.tool === expectedTool || item?.toolName === expectedTool);
  if (toolCalls.length !== 1) {
    throw new Error(`Expected exactly one completed ${expectedTool} normal-turn call, observed ${toolCalls.length}.`);
  }
  if (toolCalls[0]?.status !== expectedToolStatus) {
    throw new Error(
      `Expected ${expectedTool} status ${expectedToolStatus}, observed ${String(toolCalls[0]?.status)}.`
    );
  }
  if (
    expectedResultToken !== undefined &&
    !JSON.stringify(toolCalls[0]).includes(expectedResultToken)
  ) {
    throw new Error(`${expectedTool} result did not include ${expectedResultToken}.`);
  }
  if (expectedInner !== "none" && innerRequests !== 1) {
    throw new Error(`Expected exactly one inner elicitation, observed ${innerRequests}.`);
  }
  if (expectedInner === "bare_accept_rejected") {
    const serialized = JSON.stringify(toolCalls[0]);
    if (!serialized.includes("TRUSTED_HOST_USER_DECISION_REQUIRED")) {
      throw new Error("Bare app-server elicitation acceptance did not fail closed at the trusted-user boundary.");
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      turnStatus: completed.params.turn.status,
      expectedTool,
      outerRequests,
      innerRequests,
      timeline
    }, null, 2)}\n`
  );
} catch (error) {
  process.stderr.write(`${stderr.join("")}\n`);
  throw error;
} finally {
  client.close();
  client.child.kill();
}
