/* global console */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const pluginManifestPath = path.join(
  repositoryRoot,
  "plugins",
  "routeledger",
  ".codex-plugin",
  "plugin.json"
);
const releaseMetadataPath = path.join(repositoryRoot, "plugins", "routeledger", "release.json");
const expectedVersion = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8")).version;
const releaseMetadata = JSON.parse(fs.readFileSync(releaseMetadataPath, "utf8"));
const expectedRuntimePayloadDigest = releaseMetadata.runtimeIdentity?.runtimePayloadDigest;

if (typeof expectedRuntimePayloadDigest !== "string") {
  throw new Error("Candidate release metadata has no runtimePayloadDigest.");
}
const prompt = [
  "RouteLedger host release acceptance probe.",
  "Call the RouteLedger MCP tool inspect_runtime exactly once with operation=runtime.",
  "Do not use shell commands, do not modify files, and then report whether the tool was callable."
].join(" ");

const execution = spawnSync(
  "codex",
  [
    "exec",
    "--ephemeral",
    "--json",
    "--sandbox",
    "read-only",
    "-C",
    repositoryRoot,
    prompt
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    input: "",
    timeout: 180_000,
    maxBuffer: 20 * 1024 * 1024
  }
);

if (execution.error !== undefined) {
  throw execution.error;
}

if (execution.status !== 0) {
  throw new Error(
    `Codex host probe failed with exit ${execution.status}: ${execution.stderr.trim()}`
  );
}

const events = execution.stdout
  .split(/\r?\n/u)
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));
const calls = events.filter(
  (event) =>
    event.type === "item.completed" &&
    event.item?.type === "mcp_tool_call" &&
    event.item.server === "routeledger" &&
    event.item.tool === "inspect_runtime"
);

if (calls.length !== 1) {
  throw new Error(
    `Expected one native RouteLedger inspect_runtime call, observed ${calls.length}.`
  );
}

const call = calls[0].item;
if (call.status !== "completed" || call.error !== null) {
  throw new Error(`RouteLedger host call did not complete successfully: ${JSON.stringify(call.error)}`);
}

const structured = call.result?.structured_content ?? call.result?.structuredContent;
const actualVersion = structured?.data?.runtimeIdentity?.pluginVersion;
const actualRuntimePayloadDigest = structured?.data?.runtimeIdentity?.runtimePayloadDigest;

if (structured?.ok !== true) {
  throw new Error("RouteLedger host call returned no successful structured result.");
}

if (actualVersion !== expectedVersion) {
  throw new Error(
    `Codex host loaded RouteLedger ${String(actualVersion)}, expected installed candidate ${expectedVersion}.`
  );
}

if (actualRuntimePayloadDigest !== expectedRuntimePayloadDigest) {
  throw new Error(
    `Codex host loaded runtime payload ${String(actualRuntimePayloadDigest)}, expected exact candidate ${expectedRuntimePayloadDigest}.`
  );
}

console.log(
  `Codex host plugin smoke passed: a fresh task called native inspect_runtime on the exact RouteLedger ${actualVersion} runtime payload.`
);
