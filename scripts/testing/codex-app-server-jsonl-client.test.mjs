/* global setTimeout */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  CodexAppServerJsonlClient,
  CodexAppServerProtocolError,
  CodexAppServerResponseError,
  CodexAppServerTimeoutError
} from "../lib/codex-app-server-jsonl-client.mjs";

const createHarness = (defaultTimeoutMs = 200) => {
  const serverStdout = new PassThrough();
  const serverStdin = new PassThrough();
  serverStdin.setEncoding("utf8");
  const sentLines = [];
  let sentBuffer = "";
  serverStdin.on("data", (chunk) => {
    sentBuffer += chunk;
    while (true) {
      const newlineIndex = sentBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = sentBuffer.slice(0, newlineIndex);
      sentBuffer = sentBuffer.slice(newlineIndex + 1);
      if (line.length > 0) sentLines.push(JSON.parse(line));
    }
  });
  const client = new CodexAppServerJsonlClient({
    readable: serverStdout,
    writable: serverStdin,
    defaultTimeoutMs
  });
  return {
    client,
    sentLines,
    send: (message) => serverStdout.write(`${JSON.stringify(message)}\n`),
    sendChunks: (...chunks) => chunks.forEach((chunk) => serverStdout.write(chunk)),
    close: () => client.close("test harness closed")
  };
};

const waitUntil = async (predicate, timeoutMs = 200) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("Synthetic stream did not reach expected state.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

test("correlates client requests with success and JSON-RPC error responses", async () => {
  const harness = createHarness();
  const success = harness.client.request("thread/start", { cwd: "/tmp/workspace" });
  await waitUntil(() => harness.sentLines.length === 1);
  assert.deepEqual(harness.sentLines[0], {
    method: "thread/start",
    id: 1,
    params: { cwd: "/tmp/workspace" }
  });
  harness.send({ id: 1, result: { thread: { id: "thread-1" } } });
  assert.deepEqual(await success, { thread: { id: "thread-1" } });

  const failure = harness.client.request("turn/start", { threadId: "thread-1" });
  await waitUntil(() => harness.sentLines.length === 2);
  harness.send({ id: 2, error: { code: -32602, message: "invalid params", data: { field: "input" } } });
  await assert.rejects(failure, (error) => {
    assert.ok(error instanceof CodexAppServerResponseError);
    assert.equal(error.method, "turn/start");
    assert.equal(error.code, -32602);
    assert.deepEqual(error.data, { field: "input" });
    return true;
  });
  harness.close();
});

test("parses split JSONL chunks and resolves notification waiters from live and recorded messages", async () => {
  const harness = createHarness();
  const live = harness.client.waitForMessage(
    (message) => message.method === "item/completed" && message.params?.item?.type === "mcpToolCall"
  );
  const first = JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } });
  const second = JSON.stringify({
    method: "item/completed",
    params: { item: { id: "item-1", type: "mcpToolCall", tool: "inspect_runtime" } }
  });
  harness.sendChunks(first.slice(0, 11), `${first.slice(11)}\r\n${second.slice(0, 17)}`, `${second.slice(17)}\n`);
  assert.equal((await live).params.item.id, "item-1");
  const recorded = await harness.client.waitForMessage((message) => message.method === "turn/started");
  assert.equal(recorded.params.turn.id, "turn-1");
  harness.close();
});

test("supports manual server-request responses and correlates serverRequest/resolved", async () => {
  const harness = createHarness();
  const requestPromise = harness.client.waitForServerRequest("mcpServer/elicitation/request");
  harness.send({
    method: "mcpServer/elicitation/request",
    id: "elicitation-1",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "routeledger",
      mode: "form",
      requestedSchema: { type: "object" }
    }
  });
  const request = await requestPromise;
  harness.client.respondToServerRequest(request, {
    action: "accept",
    content: { approve: true, scope: "operation" }
  });
  await waitUntil(() => harness.sentLines.length === 1);
  assert.deepEqual(harness.sentLines[0], {
    id: "elicitation-1",
    result: { action: "accept", content: { approve: true, scope: "operation" } }
  });

  const resolvedPromise = harness.client.waitForServerRequestResolved("elicitation-1");
  harness.send({
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: "elicitation-1" }
  });
  assert.equal((await resolvedPromise).params.requestId, "elicitation-1");
  assert.throws(
    () => harness.client.respondToServerRequest("elicitation-1", { action: "cancel", content: null }),
    CodexAppServerProtocolError
  );

  harness.send({ method: "tool/requestUserInput", id: 91, params: { questions: [] } });
  const numericRequest = await harness.client.waitForServerRequest("tool/requestUserInput");
  harness.client.respondToServerRequest(numericRequest, { answers: {} });
  const numericResolved = harness.client.waitForServerRequestResolved(91);
  harness.send({
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: "91" }
  });
  assert.equal((await numericResolved).params.requestId, "91");
  harness.close();
});

test("runs registered server-request handlers and emits structured handler errors", async () => {
  const harness = createHarness();
  harness.client.onServerRequest("tool/requestUserInput", async (params) => ({
    answers: { [params.questions[0].id]: { answers: [params.questions[0].options[0].label] } }
  }));
  harness.send({
    method: "tool/requestUserInput",
    id: 81,
    params: {
      questions: [{ id: "decision", options: [{ label: "Accept" }] }]
    }
  });
  await waitUntil(() => harness.sentLines.length === 1);
  assert.deepEqual(harness.sentLines[0], {
    id: 81,
    result: { answers: { decision: { answers: ["Accept"] } } }
  });

  harness.client.onServerRequest("mcpServer/elicitation/request", () => {
    throw new Error("synthetic rejection");
  });
  harness.send({ method: "mcpServer/elicitation/request", id: 82, params: {} });
  await waitUntil(() => harness.sentLines.length === 2);
  assert.deepEqual(harness.sentLines[1], {
    id: 82,
    error: { code: -32000, message: "synthetic rejection" }
  });
  harness.close();
});

test("times out requests and message waits without accepting late responses", async () => {
  const harness = createHarness(20);
  const orphanResponses = [];
  harness.client.on("orphanResponse", (message) => orphanResponses.push(message));
  const request = harness.client.request("thread/start", {}, { timeoutMs: 10 });
  await assert.rejects(request, CodexAppServerTimeoutError);
  harness.send({ id: 1, result: { thread: { id: "late" } } });
  await waitUntil(() => orphanResponses.length === 1);
  assert.equal(orphanResponses[0].result.thread.id, "late");
  await assert.rejects(
    harness.client.waitForMessage((message) => message.method === "never", {
      timeoutMs: 10,
      description: "synthetic never notification"
    }),
    CodexAppServerTimeoutError
  );
  harness.close();
});

test("fails pending work closed on malformed JSONL and stream closure", async () => {
  const malformedHarness = createHarness();
  const protocolErrors = [];
  malformedHarness.client.on("protocolError", (error) => protocolErrors.push(error));
  const pending = malformedHarness.client.request("thread/start");
  malformedHarness.sendChunks("not-json\n");
  await assert.rejects(pending, CodexAppServerProtocolError);
  assert.equal(protocolErrors.length, 1);
  assert.throws(() => malformedHarness.client.notify("initialized"), CodexAppServerProtocolError);

  const closeHarness = createHarness();
  const pendingAfterClose = closeHarness.client.request("turn/start");
  closeHarness.client.readable.end();
  await assert.rejects(pendingAfterClose, /stdout ended|stdout closed/u);
});
