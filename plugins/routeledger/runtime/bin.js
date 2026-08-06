#!/usr/bin/env node
process.env.ROUTELEDGER_MCP_RUNTIME_PROFILE = "json-only";

const sqliteReadModelFlag = "--sqlite-read-model";
const flagIndex = process.argv.indexOf(sqliteReadModelFlag);

if (flagIndex === -1 || process.argv[flagIndex + 1] !== "disabled") {
  process.stderr.write(
    "@routeledger/mcp JSON-only artifact requires --sqlite-read-model disabled.\n"
  );
  process.exitCode = 2;
} else {
  await import("./mcp/src/bin.js");
}
