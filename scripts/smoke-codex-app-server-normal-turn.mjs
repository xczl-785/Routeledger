#!/usr/bin/env node

import process from "node:process";

import { spawnCodexAppServerJsonlClient } from "./lib/codex-app-server-jsonl-client.mjs";

const cwd = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_CWD;
const prompt = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_PROMPT;
const expectedTool = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_TOOL;
const expectedInner = process.env.ROUTELEDGER_CODEX_NORMAL_TURN_INNER ?? "none";
const timeoutMs = Number(process.env.ROUTELEDGER_CODEX_NORMAL_TURN_TIMEOUT_MS ?? 180_000);

if (!cwd || !prompt || !expectedTool) {
  throw new Error(
    "ROUTELEDGER_CODEX_NORMAL_TURN_CWD, ROUTELEDGER_CODEX_NORMAL_TURN_PROMPT, and ROUTELEDGER_CODEX_NORMAL_TURN_TOOL are required."
  );
}
if (!["none", "bare_accept_rejected", "cancel"].includes(expectedInner)) {
  throw new Error("ROUTELEDGER_CODEX_NORMAL_TURN_INNER must be none, bare_accept_rejected, or cancel.");
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error("ROUTELEDGER_CODEX_NORMAL_TURN_TIMEOUT_MS must be a positive number.");
}

const client = spawnCodexAppServerJsonlClient({ cwd, defaultTimeoutMs: timeoutMs });
const stderr = [];
client.stderr.on("data", (chunk) => stderr.push(String(chunk)));

const timeline = [];
let innerRequests = 0;
client.on("message", (message) => {
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

client.onServerRequest("mcpServer/elicitation/request", () => {
  innerRequests += 1;
  if (expectedInner === "none") {
    throw new Error("Unexpected inner RouteLedger elicitation in a no-prompt scenario.");
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
    serviceName: "routeledger-normal-turn-smoke"
  });
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string") throw new Error("Codex app-server returned no thread id.");
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
    `${JSON.stringify({ ok: true, turnStatus: completed.params.turn.status, expectedTool, innerRequests, timeline }, null, 2)}\n`
  );
} catch (error) {
  process.stderr.write(`${stderr.join("")}\n`);
  throw error;
} finally {
  client.close();
  client.child.kill();
}
