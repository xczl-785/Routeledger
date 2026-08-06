export * from "./mcp/src/index.js";
import { createRouteLedgerMcpRegistry as createSharedRegistry } from "./mcp/src/index.js";

export const createRouteLedgerMcpRegistry = (options = {}) =>
  createSharedRegistry({ ...options, runtimeProfile: "json-only" });
