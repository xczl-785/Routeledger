/* global Buffer, console, process */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const routeledgerRoot = path.resolve(scriptDir, "..");
const workspaceRoot = routeledgerRoot;
const pluginRoot = path.join(workspaceRoot, "plugins", "routeledger");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const mcpManifestPath = path.join(pluginRoot, ".mcp.json");
const marketplacePath = path.join(workspaceRoot, ".agents", "plugins", "marketplace.json");
const releaseCheckerPath = path.join(routeledgerRoot, "scripts", "check-codex-plugin-release.mjs");
const buildPluginPath = path.join(routeledgerRoot, "scripts", "build-codex-plugin.mjs");
const validatorPath = path.join(
  os.homedir(),
  ".codex",
  "skills",
  ".system",
  "plugin-creator",
  "scripts",
  "validate_plugin.py"
);
const pythonCommand = process.platform === "win32" ? "python" : "python3";

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });

const assertRegularFile = async (filePath) => {
  const entry = await fs.stat(filePath).catch(() => null);
  if (!entry?.isFile()) {
    throw new Error(`Plugin distribution is missing required regular file: ${path.relative(routeledgerRoot, filePath)}.`);
  }
};

const assertPluginFiles = async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const mcpManifest = JSON.parse(await fs.readFile(mcpManifestPath, "utf8"));
  const marketplace = JSON.parse(await fs.readFile(marketplacePath, "utf8"));
  const server = mcpManifest.mcpServers?.routeledger;

  if (
    manifest.name !== "routeledger" ||
    manifest.version !== "0.3.2" ||
    manifest.repository !== "https://github.com/xczl-785/Routeledger"
  ) {
    throw new Error("Plugin manifest name/version/repository do not match the RouteLedger plugin contract.");
  }
  if (manifest.skills !== "./skills/" || manifest.mcpServers !== "./.mcp.json") {
    throw new Error("Plugin manifest component paths do not match the plugin contract.");
  }
  if (
    server?.cwd !== "." ||
    server?.command !== "node" ||
    JSON.stringify(server?.args) !==
      JSON.stringify(["./runtime/bin.js", "--profile", "codex", "--sqlite-read-model", "disabled"])
  ) {
    throw new Error("Plugin MCP server must be the relative bundled JSON-only runtime command.");
  }
  const listing = marketplace.plugins?.find((plugin) => plugin.name === "routeledger");
  if (
    marketplace.name !== "routeledger-team" ||
    marketplace.interface?.displayName !== "RouteLedger Team" ||
    listing?.source?.source !== "local" ||
    listing?.source?.path !== "./plugins/routeledger" ||
    listing?.policy?.installation !== "AVAILABLE" ||
    listing?.policy?.authentication !== "ON_INSTALL" ||
    listing?.category !== "Productivity"
  ) {
    throw new Error("Repo-local marketplace does not contain the required RouteLedger listing.");
  }
  await Promise.all([
    assertRegularFile(path.join(pluginRoot, "skills", "routeledger-operator", "SKILL.md")),
    assertRegularFile(path.join(pluginRoot, "runtime", "bin.js")),
    assertRegularFile(path.join(pluginRoot, "runtime", "package.json"))
  ]);
};

const runOptionalExternalValidator = async () => {
  if (!(await fs.stat(validatorPath).catch(() => null))) {
    console.log(
      `Codex plugin external validator skipped: ${validatorPath} is not installed; repo-local shape, hash, and stdio checks remain required.`
    );
    return;
  }

  try {
    run(pythonCommand, [validatorPath, pluginRoot], { cwd: workspaceRoot });
  } catch (error) {
    const detail = error.stderr?.toString("utf8").trim();
    throw new Error(
      `Codex plugin external validator failed at ${validatorPath}${detail ? `: ${detail}` : "."}`
    );
  }
  console.log(`Codex plugin external validator passed: ${validatorPath}`);
};

const runPluginStdioSmoke = async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-codex-plugin-smoke-"));
  const testWorkspaceRoot = path.join(temporaryRoot, "workspace");
  const testRouteledgerRoot = path.join(testWorkspaceRoot, "routeledger");
  const routeledgerConfigDir = path.join(testWorkspaceRoot, ".routeledger");
  await fs.mkdir(testRouteledgerRoot, { recursive: true });
  await fs.mkdir(routeledgerConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(routeledgerConfigDir, "config.json"),
    `${JSON.stringify({ version: 1, dataDir: "routeledger" }, null, 2)}\n`,
    "utf8"
  );

  const child = spawn(process.execPath, ["./runtime/bin.js", "--profile", "codex", "--sqlite-read-model", "disabled"], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const write = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  write({
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      rootUri: pathToFileURL(testWorkspaceRoot).href,
      capabilities: {},
      clientInfo: { name: "codex-plugin-smoke", version: "0.1.0" }
    }
  });
  write({ jsonrpc: "2.0", method: "notifications/initialized" });
  write({ jsonrpc: "2.0", id: "tools-list", method: "tools/list", params: {} });
  write({
    jsonrpc: "2.0",
    id: "init-project",
    method: "tools/call",
    params: {
      name: "init_project",
      arguments: { name: "Codex Plugin Smoke", expectedRouteLedgerRoot: testRouteledgerRoot }
    }
  });
  write({
    jsonrpc: "2.0",
    id: "runtime-context",
    method: "tools/call",
    params: { name: "get_runtime_context", arguments: {} }
  });
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const responses = Buffer.concat(stdoutChunks)
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  try {
    if (exitCode !== 0 || stderr !== "" || responses.length !== 4) {
      throw new Error(`Bundled plugin stdio smoke failed (exit=${exitCode}, responses=${responses.length}): ${stderr}`);
    }
    if (responses[0]?.result?.protocolVersion !== "2025-11-25") {
      throw new Error("Bundled runtime did not initialize with the canonical protocol version.");
    }
    if (!Array.isArray(responses[1]?.result?.tools) || responses[1].result.tools.length === 0) {
      throw new Error("Bundled runtime tools/list did not expose RouteLedger tools.");
    }
    if (responses[2]?.result?.structuredContent?.ok !== true) {
      throw new Error("Bundled runtime init_project did not report a successful canonical JSON write.");
    }
    const runtimeContext = responses[3]?.result?.structuredContent?.data;
    if (
      runtimeContext?.binding?.workspaceRoot !== testWorkspaceRoot ||
      runtimeContext?.binding?.workspaceRootSource !== "mcp_roots" ||
      runtimeContext?.binding?.routeledgerRoot !== testRouteledgerRoot ||
      runtimeContext?.storage?.sqliteReadModel !== "disabled" ||
      runtimeContext?.storage?.mode !== "json"
    ) {
      throw new Error("Bundled runtime context did not preserve MCP-root binding and JSON-only storage.");
    }
    if (!(await fs.stat(path.join(testRouteledgerRoot, ".routeledger", "project.json")).catch(() => null))) {
      throw new Error("Bundled runtime did not write canonical project JSON.");
    }
    if (await fs.stat(path.join(testRouteledgerRoot, ".routeledger", "db", "routeledger.sqlite3")).catch(() => null)) {
      throw new Error("Bundled JSON-only runtime unexpectedly created a SQLite database.");
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  run(process.execPath, [buildPluginPath], { cwd: routeledgerRoot });
  await assertPluginFiles();
  run(process.execPath, [releaseCheckerPath], { cwd: routeledgerRoot });
  await runOptionalExternalValidator();
  await runPluginStdioSmoke();
  console.log("Codex plugin smoke passed: manifest, marketplace, release metadata, bundled runtime, and stdio workflow.");
};

await main();
