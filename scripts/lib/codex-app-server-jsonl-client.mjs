/* global clearTimeout, setTimeout */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 30_000;

export class CodexAppServerTimeoutError extends Error {
  constructor(description, timeoutMs) {
    super(`Timed out after ${timeoutMs}ms waiting for ${description}.`);
    this.name = "CodexAppServerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class CodexAppServerResponseError extends Error {
  constructor(method, error) {
    super(`Codex app-server request ${method} failed: ${error?.message ?? "unknown error"}`);
    this.name = "CodexAppServerResponseError";
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class CodexAppServerProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CodexAppServerProtocolError";
  }
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const requestKey = (id) => `${typeof id}:${String(id)}`;
const serverRequestKey = (id) => String(id);

export class CodexAppServerJsonlClient extends EventEmitter {
  constructor({ readable, writable, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    super();
    if (!readable || typeof readable.on !== "function") {
      throw new TypeError("readable must be a Node.js readable stream.");
    }
    if (!writable || typeof writable.write !== "function") {
      throw new TypeError("writable must be a Node.js writable stream.");
    }
    if (!Number.isFinite(defaultTimeoutMs) || defaultTimeoutMs <= 0) {
      throw new TypeError("defaultTimeoutMs must be a positive finite number.");
    }

    this.readable = readable;
    this.writable = writable;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextRequestId = 1;
    this.buffer = "";
    this.closed = false;
    this.messages = [];
    this.pendingRequests = new Map();
    this.pendingServerRequests = new Map();
    this.respondedServerRequests = new Map();
    this.serverRequestHandlers = new Map();
    this.waiters = new Set();

    readable.setEncoding?.("utf8");
    readable.on("data", (chunk) => this.#consume(String(chunk)));
    readable.on("end", () => this.#handleStreamClose("stdout ended"));
    readable.on("close", () => this.#handleStreamClose("stdout closed"));
    readable.on("error", (error) => this.#handleTransportError(error));
    writable.on?.("error", (error) => this.#handleTransportError(error));
  }

  request(method, params = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    this.#assertOpen();
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestKey(id));
        reject(new CodexAppServerTimeoutError(`response to ${method} (id ${id})`, timeoutMs));
      }, timeoutMs);
      this.pendingRequests.set(requestKey(id), { id, method, resolve, reject, timer });

      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestKey(id));
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#assertOpen();
    this.#write({ method, params });
  }

  onServerRequest(method, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("server request handler must be a function.");
    }
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  respondToServerRequest(requestOrId, result) {
    this.#assertOpen();
    const id = typeof requestOrId === "object" && requestOrId !== null ? requestOrId.id : requestOrId;
    const key = serverRequestKey(id);
    const request = this.pendingServerRequests.get(key);
    if (!request) {
      throw new CodexAppServerProtocolError(`No unanswered server request exists for id ${String(id)}.`);
    }
    this.pendingServerRequests.delete(key);
    this.respondedServerRequests.set(key, request);
    this.#write({ id, result });
  }

  respondToServerRequestError(requestOrId, error) {
    this.#assertOpen();
    const id = typeof requestOrId === "object" && requestOrId !== null ? requestOrId.id : requestOrId;
    const key = serverRequestKey(id);
    const request = this.pendingServerRequests.get(key);
    if (!request) {
      throw new CodexAppServerProtocolError(`No unanswered server request exists for id ${String(id)}.`);
    }
    this.pendingServerRequests.delete(key);
    this.respondedServerRequests.set(key, request);
    this.#write({ id, error });
  }

  waitForMessage(predicate, { timeoutMs = this.defaultTimeoutMs, description = "matching app-server message" } = {}) {
    const existing = this.messages.find((message) => predicate(message));
    if (existing !== undefined) return Promise.resolve(existing);
    if (this.closed) {
      return Promise.reject(new CodexAppServerProtocolError(`Cannot wait for ${description}: client is closed.`));
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new CodexAppServerTimeoutError(description, timeoutMs));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  waitForServerRequest(method, options = {}) {
    return this.waitForMessage(
      (message) => message?.method === method && hasOwn(message, "id"),
      { ...options, description: options.description ?? `server request ${method}` }
    );
  }

  waitForServerRequestResolved(requestId, options = {}) {
    return this.waitForMessage(
      (message) =>
        message?.method === "serverRequest/resolved" &&
        String(message.params?.requestId) === String(requestId),
      { ...options, description: options.description ?? `serverRequest/resolved for ${String(requestId)}` }
    );
  }

  close(reason = "client closed") {
    if (this.closed) return;
    this.closed = true;
    this.writable.end?.();
    this.#rejectPending(new CodexAppServerProtocolError(reason));
  }

  #assertOpen() {
    if (this.closed) throw new CodexAppServerProtocolError("Codex app-server JSONL client is closed.");
  }

  #write(message) {
    this.writable.write(`${JSON.stringify(message)}\n`);
    this.emit("sent", message);
  }

  #consume(chunk) {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (cause) {
        this.#handleProtocolError(
          new CodexAppServerProtocolError(`Invalid JSONL from Codex app-server: ${line}`, { cause })
        );
        continue;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    this.messages.push(message);
    this.emit("message", message);
    this.#resolveWaiters(message);

    if (hasOwn(message, "id") && typeof message.method === "string") {
      this.#handleServerRequest(message);
      return;
    }

    if (hasOwn(message, "id") && (hasOwn(message, "result") || hasOwn(message, "error"))) {
      const key = requestKey(message.id);
      const pending = this.pendingRequests.get(key);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      this.pendingRequests.delete(key);
      clearTimeout(pending.timer);
      if (hasOwn(message, "error")) {
        pending.reject(new CodexAppServerResponseError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method === "serverRequest/resolved") {
      const key = serverRequestKey(message.params?.requestId);
      const request = this.respondedServerRequests.get(key) ?? this.pendingServerRequests.get(key);
      if (request) {
        this.respondedServerRequests.delete(key);
        this.pendingServerRequests.delete(key);
        this.emit("serverRequestResolved", { request, notification: message });
      }
    }
  }

  #handleServerRequest(message) {
    const key = serverRequestKey(message.id);
    if (this.pendingServerRequests.has(key) || this.respondedServerRequests.has(key)) {
      this.#handleProtocolError(
        new CodexAppServerProtocolError(`Duplicate server request id ${String(message.id)}.`)
      );
      return;
    }
    this.pendingServerRequests.set(key, message);
    this.emit("serverRequest", message);

    const handler = this.serverRequestHandlers.get(message.method);
    if (!handler) return;
    Promise.resolve()
      .then(() => handler(message.params, message))
      .then((result) => {
        if (this.pendingServerRequests.has(key)) this.respondToServerRequest(message, result);
      })
      .catch((error) => {
        if (!this.pendingServerRequests.has(key)) return;
        this.respondToServerRequestError(message, {
          code: -32_000,
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }

  #resolveWaiters(message) {
    for (const waiter of [...this.waiters]) {
      let matches = false;
      try {
        matches = waiter.predicate(message);
      } catch (error) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.reject(error);
        continue;
      }
      if (!matches) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }

  #handleProtocolError(error) {
    this.closed = true;
    this.emit("protocolError", error);
    this.#rejectPending(error);
  }

  #handleTransportError(error) {
    const wrapped = new CodexAppServerProtocolError(`Codex app-server transport failed: ${error.message}`, {
      cause: error
    });
    this.closed = true;
    this.emit("transportError", wrapped);
    this.#rejectPending(wrapped);
  }

  #handleStreamClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.#rejectPending(new CodexAppServerProtocolError(`Codex app-server ${reason}.`));
  }

  #rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
    this.pendingServerRequests.clear();
    this.respondedServerRequests.clear();
  }
}

export const spawnCodexAppServerJsonlClient = ({
  command = "codex",
  args = ["app-server", "--stdio"],
  cwd,
  env = process.env,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  spawnOptions = {}
} = {}) => {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...spawnOptions
  });
  const client = new CodexAppServerJsonlClient({
    readable: child.stdout,
    writable: child.stdin,
    defaultTimeoutMs
  });
  client.child = child;
  client.stderr = child.stderr;
  child.on("exit", (code, signal) => client.emit("processExit", { code, signal }));
  return client;
};
