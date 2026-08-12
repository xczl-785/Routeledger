/* global Buffer, console, process */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const routeledgerRoot = path.resolve(scriptDir, "..");
const workspaceRoot = routeledgerRoot;
const pluginRoot = path.join(workspaceRoot, "plugins", "routeledger");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const mcpManifestPath = path.join(pluginRoot, ".mcp.json");
const marketplacePath = path.join(workspaceRoot, ".agents", "plugins", "marketplace.json");
const releaseCheckerPath = path.join(routeledgerRoot, "scripts", "check-codex-plugin-release.mjs");
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

const assertPathAbsent = async (filePath, description) => {
  if (await fs.stat(filePath).catch(() => null)) {
    throw new Error(description);
  }
};

const normalizeRealPathForComparison = async (filePath) => {
  const normalizedPath = path.normalize(await fs.realpath(filePath));
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
};

const assertPluginFiles = async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const mcpManifest = JSON.parse(await fs.readFile(mcpManifestPath, "utf8"));
  const marketplace = JSON.parse(await fs.readFile(marketplacePath, "utf8"));
  const server = mcpManifest.mcpServers?.routeledger;

  if (
    manifest.name !== "routeledger" ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.version) ||
    manifest.repository !== "https://github.com/xczl-785/Routeledger"
  ) {
    throw new Error("Plugin manifest name/version/repository do not match the RouteLedger plugin contract.");
  }
  if (manifest.skills !== "./skills/" || manifest.mcpServers !== "./.mcp.json") {
    throw new Error("Plugin manifest component paths do not match the plugin contract.");
  }
  if (
    !manifest.interface?.defaultPrompt?.includes(
      "Check the current RouteLedger context; if it is unbound, bind the current host project before route work."
    )
  ) {
    throw new Error("Plugin default prompt must direct unbound sessions to bind the current host project.");
  }
  if (
    server?.cwd !== "." ||
    server?.command !== "node" ||
    JSON.stringify(server?.env_vars) !== JSON.stringify(["CODEX_PERMISSION_PROFILE"]) ||
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
  const operatorSkill = await fs.readFile(path.join(pluginRoot, "skills", "routeledger-operator", "SKILL.md"), "utf8");
  for (const requiredGuidance of [
    "`WORKSPACE_ROOT_UNTRUSTED` or `ROUTELEDGER_BINDING_REQUIRED`",
    "`get_runtime_context` again to confirm the session rebound",
    "Use `discover_routeledger_roots` and `plan_routeledger_binding` only when the target root is ambiguous",
    "never infer it from the plugin cache or MCP process `cwd`"
  ]) {
    if (!operatorSkill.includes(requiredGuidance)) {
      throw new Error(`RouteLedger operator Skill is missing required unbound-binding guidance: ${requiredGuidance}`);
    }
  }
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
  const cachedPluginRoot = path.join(temporaryRoot, "codex-plugin-cache", "routeledger");
  const testWorkspaceRoot = path.join(temporaryRoot, "workspace");
  const testRouteledgerRoot = path.join(testWorkspaceRoot, "routeledger");
  const routeledgerConfigDir = path.join(testWorkspaceRoot, ".routeledger");
  const cachedRouteledgerConfigDir = path.join(cachedPluginRoot, ".routeledger");
  const cachedSqlitePath = path.join(cachedRouteledgerConfigDir, "db", "routeledger.sqlite3");
  await fs.cp(pluginRoot, cachedPluginRoot, { recursive: true });
  await fs.mkdir(testRouteledgerRoot, { recursive: true });
  await fs.mkdir(routeledgerConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(routeledgerConfigDir, "config.json"),
    `${JSON.stringify({ version: 1, dataDir: "routeledger" }, null, 2)}\n`,
    "utf8"
  );

  const child = spawn(process.execPath, ["./runtime/bin.js", "--profile", "codex", "--sqlite-read-model", "disabled"], {
    cwd: cachedPluginRoot,
    env: { ...process.env, CODEX_PERMISSION_PROFILE: ":danger-full-access" },
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
      capabilities: {},
      clientInfo: { name: "codex-plugin-smoke", version: "0.1.0" }
    }
  });
  write({ jsonrpc: "2.0", method: "notifications/initialized" });
  write({ jsonrpc: "2.0", id: "tools-list", method: "tools/list", params: {} });
  write({
    jsonrpc: "2.0",
    id: "legacy-undo-tool-removed",
    method: "tools/call",
    params: { name: "create_undo", arguments: {} }
  });
  write({
    jsonrpc: "2.0",
    id: "runtime-context-unbound",
    method: "tools/call",
    params: { name: "get_runtime_context", arguments: {} }
  });
  write({
    jsonrpc: "2.0",
    id: "init-project",
    method: "tools/call",
    params: {
      name: "init_project",
      arguments: {
        name: "Codex Plugin Smoke",
        contentLocale: "en",
        expectedRouteLedgerRoot: testRouteledgerRoot
      }
    }
  });
  write({
    jsonrpc: "2.0",
    id: "activate-binding",
    method: "tools/call",
    params: {
      name: "activate_routeledger_binding",
      arguments: { workspaceRoot: testWorkspaceRoot, routeledgerRoot: testRouteledgerRoot }
    }
  });
  write({
    jsonrpc: "2.0",
    id: "runtime-context-rebound",
    method: "tools/call",
    params: { name: "get_runtime_context", arguments: {} }
  });
  write({
    jsonrpc: "2.0",
    id: "init-project-rebound",
    method: "tools/call",
    params: {
      name: "init_project",
      arguments: {
        name: "Codex Plugin Smoke",
        contentLocale: "en",
        expectedRouteLedgerRoot: testRouteledgerRoot
      }
    }
  });
  write({
    jsonrpc: "2.0",
    id: "runtime-context-initialized",
    method: "tools/call",
    params: { name: "get_runtime_context", arguments: {} }
  });
  write({
    jsonrpc: "2.0",
    id: "authorization-status",
    method: "tools/call",
    params: { name: "get_l3_authorization_status", arguments: {} }
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
    if (exitCode !== 0 || stderr !== "" || responses.length !== 10) {
      throw new Error(`Bundled plugin stdio smoke failed (exit=${exitCode}, responses=${responses.length}): ${stderr}`);
    }
    if (responses[0]?.result?.protocolVersion !== "2025-11-25") {
      throw new Error("Bundled runtime did not initialize with the canonical protocol version.");
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const initializeIdentity = responses[0]?.result?.serverInfo?.runtimeIdentity;
    if (
      responses[0]?.result?.serverInfo?.version !== manifest.version ||
      initializeIdentity?.runtimePackageVersion !== manifest.version ||
      initializeIdentity?.runtimeProfile !== "json-only" ||
      initializeIdentity?.artifactKind !== "plugin" ||
      initializeIdentity?.pluginVersion !== manifest.version ||
      initializeIdentity?.releaseTag !== `routeledger-plugin-v${manifest.version}` ||
      !["clean", "dirty", "unavailable"].includes(initializeIdentity?.sourceTreeState) ||
      initializeIdentity?.provenanceStatus !== "external_attestation_required" ||
      initializeIdentity?.attestation?.strategy !== "git-tag-external" ||
      initializeIdentity?.attestation?.repositoryUrl !==
        "https://github.com/xczl-785/Routeledger" ||
      initializeIdentity?.attestation?.releaseTag !== `routeledger-plugin-v${manifest.version}` ||
      initializeIdentity?.attestation?.assetName !==
        `routeledger-plugin-v${manifest.version}-attestation.json` ||
      initializeIdentity?.attestation?.downloadUrl !==
        `https://github.com/xczl-785/Routeledger/releases/download/routeledger-plugin-v${manifest.version}/routeledger-plugin-v${manifest.version}-attestation.json` ||
      initializeIdentity?.buildCommit !== null ||
      typeof initializeIdentity?.runtimePayloadDigest !== "string"
    ) {
      throw new Error("Bundled runtime initialize did not expose the plugin artifact identity.");
    }
    if (!Array.isArray(responses[1]?.result?.tools) || responses[1].result.tools.length === 0) {
      throw new Error("Bundled runtime tools/list did not expose RouteLedger tools.");
    }
    const bundledToolNames = responses[1].result.tools.map((tool) => tool.name);
    for (const sourceOnlyTool of ["open_mission_control", "get_mission_control_status"]) {
      if (bundledToolNames.includes(sourceOnlyTool)) {
        throw new Error(`Bundled JSON-only runtime unexpectedly exposed ${sourceOnlyTool}.`);
      }
    }
    if (
      responses[2]?.error?.code !== -32602 ||
      responses[2]?.error?.message !== "Unknown tool 'create_undo'."
    ) {
      throw new Error("Bundled runtime still exposes removed legacy Undo write tools.");
    }
    const unboundRuntimeContext = responses[3]?.result?.structuredContent?.data;
    const expectedCacheRoot = await normalizeRealPathForComparison(cachedPluginRoot);
    const runtimeProcessCwd = unboundRuntimeContext?.processCwd;
    const normalizedRuntimeProcessCwd =
      typeof runtimeProcessCwd === "string"
        ? await normalizeRealPathForComparison(runtimeProcessCwd).catch(() => null)
        : null;
    if (
      unboundRuntimeContext?.binding?.status !== "unbound" ||
      unboundRuntimeContext?.binding?.workspaceRootSource !== "process_cwd" ||
      normalizedRuntimeProcessCwd !== expectedCacheRoot ||
      unboundRuntimeContext?.storage?.mode !== "unbound" ||
      !unboundRuntimeContext?.diagnostics?.some((diagnostic) => diagnostic?.code === "WORKSPACE_ROOT_UNTRUSTED")
    ) {
      throw new Error(
        `Bundled runtime did not fail closed when Codex supplied neither rootUri nor Roots: ${JSON.stringify({
          status: unboundRuntimeContext?.binding?.status,
          source: unboundRuntimeContext?.binding?.workspaceRootSource,
          storage: unboundRuntimeContext?.storage?.mode,
          processCwd: runtimeProcessCwd,
          expectedCacheRoot,
          normalizedProcessCwd: normalizedRuntimeProcessCwd,
          diagnosticCodes: unboundRuntimeContext?.diagnostics?.map((diagnostic) => diagnostic?.code)
        })}`
      );
    }
    const unboundInit = responses[4]?.result;
    if (
      unboundInit?.isError !== true ||
      unboundInit?.structuredContent?.error?.code !== "ROUTELEDGER_BINDING_REQUIRED"
    ) {
      throw new Error("Bundled runtime allowed init_project before an explicit workspace binding.");
    }
    const activation = responses[5]?.result?.structuredContent?.data;
    if (
      activation?.status !== "activated" ||
      activation?.rebound !== true ||
      activation?.activeBinding?.workspaceRoot !== testWorkspaceRoot ||
      activation?.activeBinding?.workspaceRootSource !== "explicit_arg" ||
      activation?.activeBinding?.routeledgerRoot !== testRouteledgerRoot
    ) {
      throw new Error("Bundled runtime did not activate and rebind the explicit host workspace.");
    }
    const runtimeContext = responses[6]?.result?.structuredContent?.data;
    if (
      runtimeContext?.binding?.workspaceRoot !== testWorkspaceRoot ||
      runtimeContext?.binding?.workspaceRootSource !== "explicit_arg" ||
      runtimeContext?.binding?.routeledgerRoot !== testRouteledgerRoot ||
      runtimeContext?.storage?.sqliteReadModel !== "disabled" ||
      runtimeContext?.storage?.mode !== "uninitialized" ||
      runtimeContext?.runtimeIdentity?.attestation?.downloadUrl !==
        `https://github.com/xczl-785/Routeledger/releases/download/routeledger-plugin-v${manifest.version}/routeledger-plugin-v${manifest.version}-attestation.json`
    ) {
      throw new Error("Bundled runtime context did not preserve the explicit rebound binding before initialization.");
    }
    if (responses[7]?.result?.structuredContent?.ok !== true) {
      throw new Error("Bundled runtime init_project did not report a successful canonical JSON write after session rebound.");
    }
    const initializedRuntimeContext = responses[8]?.result?.structuredContent?.data;
    if (
      initializedRuntimeContext?.binding?.workspaceRoot !== testWorkspaceRoot ||
      initializedRuntimeContext?.binding?.workspaceRootSource !== "explicit_arg" ||
      initializedRuntimeContext?.binding?.routeledgerRoot !== testRouteledgerRoot ||
      initializedRuntimeContext?.storage?.sqliteReadModel !== "disabled" ||
      initializedRuntimeContext?.storage?.mode !== "json"
    ) {
      throw new Error("Bundled runtime did not initialize JSON-only storage after the explicit session rebound.");
    }
    if (JSON.stringify(initializedRuntimeContext?.runtimeIdentity) !== JSON.stringify(initializeIdentity)) {
      throw new Error("Bundled runtime initialize and get_runtime_context reported different identities.");
    }
    const authorizationStatus = responses[9]?.result?.structuredContent?.data;
    if (
      authorizationStatus?.controlPlane !== "codex_native_tool_admission_v2" ||
      authorizationStatus?.authorizationBackend !== "exact_authorization_receipt" ||
      authorizationStatus?.profileCompatible !== null ||
      authorizationStatus?.effectiveMode?.mode !== "preauthorized" ||
      authorizationStatus?.effectiveMode?.codexPermissionProfile !== ":danger-full-access"
    ) {
      throw new Error(
        `Bundled runtime did not resolve the forwarded Codex permission profile: ${JSON.stringify(authorizationStatus)}`
      );
    }
    if (!(await fs.stat(path.join(testRouteledgerRoot, ".routeledger", "project.json")).catch(() => null))) {
      throw new Error("Bundled runtime did not write canonical project JSON.");
    }
    if (await fs.stat(path.join(testRouteledgerRoot, ".routeledger", "db", "routeledger.sqlite3")).catch(() => null)) {
      throw new Error("Bundled JSON-only runtime unexpectedly created a SQLite database.");
    }
    await assertPathAbsent(
      cachedRouteledgerConfigDir,
      "Bundled runtime treated the Codex plugin cache cwd as a RouteLedger initialization target."
    );
    await assertPathAbsent(
      cachedSqlitePath,
      "Bundled JSON-only runtime unexpectedly created a SQLite database in the Codex plugin cache cwd."
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
};

const main = async () => {
  await assertPluginFiles();
  run(process.execPath, [releaseCheckerPath], { cwd: routeledgerRoot });
  await runOptionalExternalValidator();
  await runPluginStdioSmoke();
  console.log("Codex plugin smoke passed: manifest, marketplace, release metadata, bundled runtime, and stdio workflow.");
};

await main();
