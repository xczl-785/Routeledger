/* global Buffer, console, process */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageDir, "../..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const artifactDirectories = {
  full: path.join(packageDir, "dist"),
  "json-only": path.join(packageDir, "dist-plugin-runtime")
};

const resolveSmokeOptions = (argv) => {
  let profileName = "full";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      profileName = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown smoke-package argument: ${argument}`);
  }

  const artifactDir = artifactDirectories[profileName];
  if (artifactDir === undefined) {
    throw new Error(`Unsupported MCP package smoke profile: ${profileName}`);
  }

  return {
    profileName,
    artifactDir,
    sqliteReadModel: profileName === "json-only" ? "disabled" : "enabled"
  };
};

const run = (command, args, options = {}) => {
  const executionOptions = {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  };

  if (process.platform === "win32" && command === npmCommand) {
    const quoteForCmd = (value) =>
      /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value;
    return execFileSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
      executionOptions
    );
  }

  return execFileSync(command, args, executionOptions);
};

const readTarballPackageJson = async (tarballPath) => {
  const archive = gunzipSync(await fs.readFile(tarballPath));
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name.length === 0) {
      break;
    }

    const sizeText = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Could not parse tar entry size for ${name}.`);
    }

    const contentStart = offset + 512;
    if (name === "package/package.json") {
      return JSON.parse(archive.subarray(contentStart, contentStart + size).toString("utf8"));
    }

    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  throw new Error("npm pack tarball did not contain package/package.json.");
};

const containsDirectoryNamed = async (directory, expectedName) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === expectedName || (await containsDirectoryNamed(entryPath, expectedName))) {
        return true;
      }
    }
  }
  return false;
};

const collectFiles = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
};

const assertJsonOnlyArtifactTree = async (artifactDir) => {
  const artifactPackage = JSON.parse(await fs.readFile(path.join(artifactDir, "package.json"), "utf8"));
  const declaredEntries = new Set(
    artifactPackage.files.map((entry) => entry.replace(/\/$/, ""))
  );
  declaredEntries.add("package.json");

  const topLevelEntries = await fs.readdir(artifactDir, { withFileTypes: true });
  for (const entry of topLevelEntries) {
    if (!declaredEntries.has(entry.name)) {
      throw new Error(`JSON-only artifact contains undeclared top-level entry: ${entry.name}`);
    }
  }

  for (const forbiddenDirectory of ["sqlite"]) {
    if (await fs.stat(path.join(artifactDir, forbiddenDirectory)).catch(() => null)) {
      throw new Error(`JSON-only artifact unexpectedly contains ${forbiddenDirectory}/ runtime bundle.`);
    }
  }

  const forbiddenReference = Buffer.from("better-sqlite3");
  for (const filePath of await collectFiles(artifactDir)) {
    if (path.relative(artifactDir, filePath) === "README.md") {
      continue;
    }
    const contents = await fs.readFile(filePath);
    if (contents.includes(forbiddenReference)) {
      throw new Error(
        `JSON-only artifact contains a better-sqlite3 reference outside README: ${filePath}`
      );
    }
  }
};

const assertJsonOnlyEntryRequiresDisabled = async (installDir) => {
  const child = spawn(
    process.execPath,
    [path.join(installDir, "node_modules/@routeledger/mcp/bin.js"), "--profile", "codex"],
    {
      cwd: installDir,
      stdio: ["ignore", "ignore", "pipe"]
    }
  );
  const stderrChunks = [];
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  const stderrText = Buffer.concat(stderrChunks).toString("utf8");

  if (exitCode !== 2 || !stderrText.includes("requires --sqlite-read-model disabled")) {
    throw new Error("JSON-only bin did not reject a launch without --sqlite-read-model disabled.");
  }
};

const assertDirectImportProfile = async ({
  installDir,
  workspaceRoot,
  routeledgerRoot,
  sqliteReadModel,
  profileName
}) => {
  const packageEntry = path.join(installDir, "node_modules/@routeledger/mcp/index.js");
  const imported = await import(`${pathToFileURL(packageEntry).href}?profile-smoke=${Date.now()}`);
  const registry = imported.createRouteLedgerMcpRegistry({
    workspaceRoot,
    routeledgerRoot,
    sqliteReadModel
  });

  try {
    if (registry.runtimeProfile !== profileName) {
      throw new Error(
        `Direct package import reported runtimeProfile=${registry.runtimeProfile}; expected ${profileName}.`
      );
    }

    const missionControlTools = ["inspect_runtime", "manage_mission_control"];
    for (const toolName of missionControlTools) {
      const exposed = registry.getTool(toolName) !== undefined;
      if (!exposed) {
        throw new Error(`Direct ${profileName} package import did not expose ${toolName}.`);
      }
    }

    const status = await registry.invoke("inspect_runtime", {
      operation: "mission_control_status",
      workspaceRoot,
      routeledgerRoot
    });
    if (!status.ok) {
      throw new Error(
        `Direct ${profileName} package import could not invoke Mission Control: ${JSON.stringify(status.error)}`
      );
    }
  } finally {
    registry.close();
  }
};

const assertPackagedIdempotencyRestart = async ({
  installDir,
  workspaceRoot,
  routeledgerRoot,
  sqliteReadModel,
  initialized
}) => {
  const packageEntry = path.join(installDir, "node_modules/@routeledger/mcp/index.js");
  const imported = await import(
    `${pathToFileURL(packageEntry).href}?idempotency-smoke=${Date.now()}`
  );
  const createRegistry = () =>
    imported.createRouteLedgerMcpRegistry({
      workspaceRoot,
      routeledgerRoot,
      sqliteReadModel
    });
  const createInput = {
    projectId: initialized.project.id,
    versionId: initialized.firstVersion.id,
    title: "Packaged idempotency restart",
    idempotencyKey: "package-smoke-create-restart",
    expectedRouteLedgerRoot: routeledgerRoot
  };
  let registry = createRegistry();
  let firstCreate;
  let firstClose;

  try {
    firstCreate = await registry.invoke("manage_todo", { operation: "create", ...createInput });
    if (!firstCreate.ok || firstCreate.data?.idempotency?.replayed !== false) {
      throw new Error(
        `Packaged create_todo did not commit an idempotency receipt: ${JSON.stringify(firstCreate)}`
      );
    }
    firstClose = await registry.invoke("manage_todo", {
      operation: "close",
      projectId: initialized.project.id,
      todoId: firstCreate.data.todo.id,
      reason: "package smoke complete",
      note: "close exactly once",
      idempotencyKey: "package-smoke-close-restart",
      expectedRouteLedgerRoot: routeledgerRoot
    });
    if (!firstClose.ok || firstClose.data?.idempotency?.replayed !== false) {
      throw new Error(
        `Packaged close_todo did not commit an idempotency receipt: ${JSON.stringify(firstClose)}`
      );
    }
  } finally {
    registry.close();
  }

  registry = createRegistry();
  try {
    const replayedCreate = await registry.invoke("manage_todo", { operation: "create", ...createInput });
    const replayedClose = await registry.invoke("manage_todo", {
      operation: "close",
      projectId: initialized.project.id,
      todoId: firstCreate.data.todo.id,
      reason: "package smoke complete",
      note: "close exactly once",
      idempotencyKey: "package-smoke-close-restart",
      expectedRouteLedgerRoot: routeledgerRoot
    });
    if (
      !replayedCreate.ok ||
      replayedCreate.data?.todo?.id !== firstCreate.data.todo.id ||
      replayedCreate.data?.idempotency?.replayed !== true ||
      !replayedClose.ok ||
      replayedClose.data?.todo?.id !== firstClose.data.todo.id ||
      replayedClose.data?.idempotency?.replayed !== true
    ) {
      throw new Error(
        `Packaged ordinary writes did not replay after registry restart: ${JSON.stringify({ replayedCreate, replayedClose })}`
      );
    }
    const conflict = await registry.invoke("manage_todo", {
      operation: "close",
      projectId: initialized.project.id,
      todoId: firstCreate.data.todo.id,
      reason: "package smoke complete",
      note: "different input",
      idempotencyKey: "package-smoke-close-restart",
      expectedRouteLedgerRoot: routeledgerRoot
    });
    if (conflict.ok || conflict.error?.code !== "IDEMPOTENCY_KEY_REUSE_MISMATCH") {
      throw new Error(
        `Packaged idempotency key reuse did not fail closed: ${JSON.stringify(conflict)}`
      );
    }
  } finally {
    registry.close();
  }
};

const runStdioSmoke = async ({
  installDir,
  workspaceRoot,
  routeledgerRoot,
  sqliteReadModel,
  profileName
}) => {
  const child = spawn(
    process.execPath,
    [
      path.join(installDir, "node_modules/@routeledger/mcp/bin.js"),
      "--profile",
      "codex",
      "--sqlite-read-model",
      sqliteReadModel
    ],
    {
      cwd: installDir,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  const stdoutChunks = [];
  const stderrChunks = [];

  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        rootUri: pathToFileURL(workspaceRoot).href,
        capabilities: {},
        clientInfo: {
          name: "package-smoke",
          version: "0.0.0"
        }
      }
    })}\n`
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    })}\n`
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "tools-list",
      method: "tools/list",
      params: {
      }
    })}\n`
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "init-project",
      method: "tools/call",
      params: {
        name: "configure_project",
        arguments: {
          operation: "initialize",
          name: "Packaged MCP Runtime Smoke",
          contentLocale: "en",
          firstVersion: {
            title: "Packaged idempotency smoke",
            description: "",
            initialTodos: []
          },
          expectedRouteLedgerRoot: routeledgerRoot
        }
      }
    })}\n`
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: "runtime-context",
      method: "tools/call",
      params: {
        name: "inspect_runtime",
        arguments: { operation: "runtime" }
      }
    })}\n`
  );
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });

  const stdoutText = Buffer.concat(stdoutChunks).toString("utf8").trim();
  const stderrText = Buffer.concat(stderrChunks).toString("utf8");
  const stdoutLines =
    stdoutText.length === 0
      ? []
      : stdoutText
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line));

  if (stderrText !== "") {
    throw new Error(`Packaged stdio smoke leaked stderr:\n${stderrText}`);
  }

  if (exitCode !== 0) {
    throw new Error(`Packaged stdio smoke exited with code ${exitCode}.`);
  }

  if (stdoutLines.length !== 4) {
    throw new Error(`Expected 4 JSON-RPC responses, received ${stdoutLines.length}.`);
  }

  if (stdoutLines[0]?.result?.protocolVersion !== "2025-11-25") {
    throw new Error("initialize response did not report protocolVersion=2025-11-25.");
  }

  if (!Array.isArray(stdoutLines[1]?.result?.tools) || stdoutLines[1].result.tools.length === 0) {
    throw new Error("tools/list response did not include RouteLedger tools.");
  }
  const listedToolNames = stdoutLines[1].result.tools.map((tool) => tool.name);
  const missionControlToolNames = ["manage_mission_control"];
  for (const toolName of missionControlToolNames) {
    if (!listedToolNames.includes(toolName)) {
      throw new Error(`${profileName} tools/list did not expose ${toolName}.`);
    }
  }

  if (stdoutLines[2]?.result?.structuredContent?.ok !== true) {
    throw new Error("configure_project(operation=initialize) did not report a successful canonical JSON write.");
  }
  const initializedProject = stdoutLines[2]?.result?.structuredContent?.data;
  if (Object.prototype.hasOwnProperty.call(initializedProject ?? {}, "documentation")) {
    throw new Error("Codex agent-only initialization did not omit human-entry-document metadata.");
  }

  const runtimeContext = stdoutLines[3]?.result?.structuredContent?.data;
  if (runtimeContext?.binding?.workspaceRoot !== workspaceRoot) {
    throw new Error("inspect_runtime(operation=runtime) did not bind workspaceRoot from initialize rootUri.");
  }
  if (runtimeContext?.binding?.workspaceRootSource !== "mcp_roots") {
    throw new Error("inspect_runtime(operation=runtime) did not report workspaceRootSource=mcp_roots.");
  }
  if (runtimeContext?.binding?.routeledgerRoot !== routeledgerRoot) {
    throw new Error("inspect_runtime(operation=runtime) did not resolve routeledgerRoot from workspace config.");
  }

  if (runtimeContext?.storage?.sqliteReadModel !== sqliteReadModel) {
    throw new Error(`inspect_runtime(operation=runtime) did not report sqliteReadModel=${sqliteReadModel}.`);
  }
  if (runtimeContext?.runtimeProfile !== profileName) {
    throw new Error(`inspect_runtime(operation=runtime) did not report runtimeProfile=${profileName}.`);
  }
  if (runtimeContext?.contentLocale?.scope !== "project_content_only") {
    throw new Error("inspect_runtime(operation=runtime) did not report the project-content-only locale scope.");
  }
  if (
    runtimeContext?.missionControl?.status !== "stopped" ||
    runtimeContext?.missionControl?.notice?.code !== "MISSION_CONTROL_STOPPED" ||
    runtimeContext?.missionControl?.recommendedAction !== null ||
    runtimeContext?.missionControl?.recommendationLevel !== "advisory" ||
    runtimeContext?.missionControl?.advisoryAction?.tool !== "manage_mission_control" ||
    runtimeContext?.missionControl?.advisoryAction?.arguments?.operation !== "open"
  ) {
    throw new Error(
      `inspect_runtime(operation=runtime) did not report advisory Mission Control startup guidance: ${JSON.stringify(runtimeContext?.missionControl)}`
    );
  }
  if (
    runtimeContext?.runtimeIdentity?.runtimePackageVersion !== "0.0.0-package-prep" ||
    runtimeContext?.runtimeIdentity?.runtimeProfile !== profileName ||
    runtimeContext?.runtimeIdentity?.artifactKind !== "package" ||
    runtimeContext?.runtimeIdentity?.pluginVersion !== null ||
    typeof runtimeContext?.runtimeIdentity?.runtimePayloadDigest !== "string"
  ) {
    throw new Error("inspect_runtime(operation=runtime) did not report the generated package runtime identity.");
  }
  const sourceTreeState = runtimeContext.runtimeIdentity.sourceTreeState;
  if (
    !["clean", "dirty", "unavailable"].includes(sourceTreeState) ||
    (sourceTreeState === "clean" && typeof runtimeContext.runtimeIdentity.buildCommit !== "string") ||
    (sourceTreeState !== "clean" && runtimeContext.runtimeIdentity.buildCommit !== null)
  ) {
    throw new Error("Generated package runtime identity reported an unverifiable build commit.");
  }
  const initializeIdentity = stdoutLines[0]?.result?.serverInfo?.runtimeIdentity;
  if (JSON.stringify(initializeIdentity) !== JSON.stringify(runtimeContext.runtimeIdentity)) {
    throw new Error("initialize serverInfo and inspect_runtime(operation=runtime) reported different runtime identities.");
  }

  return {
    runtimeContext,
    initialized: stdoutLines[2]?.result?.structuredContent?.data
  };
};

const main = async () => {
  const { profileName, artifactDir, sqliteReadModel } = resolveSmokeOptions(process.argv.slice(2));
  const buildArgs = [path.join(scriptDir, "build-package.mjs")];
  if (profileName !== "full") {
    buildArgs.push("--profile", profileName);
  }
  run(process.execPath, buildArgs);

  if (profileName === "json-only") {
    await assertJsonOnlyArtifactTree(artifactDir);
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-mcp-pack-smoke-"));
  const previousXdgStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(tmpRoot, "ui-state");
  const packArgs = ["pack", "--json"];
  let tarballDirectory = artifactDir;

  if (profileName === "json-only") {
    tarballDirectory = path.join(tmpRoot, "pack");
    await fs.mkdir(tarballDirectory, { recursive: true });
    packArgs.push("--pack-destination", tarballDirectory);
  }

  const packOutput = run(npmCommand, packArgs, { cwd: artifactDir });
  const packResult = JSON.parse(packOutput);
  const tarballFilename = packResult[0]?.filename;

  if (typeof tarballFilename !== "string" || tarballFilename.length === 0) {
    throw new Error(`npm pack did not return a tarball filename.\n${packOutput}`);
  }

  const tarballPath = path.join(tarballDirectory, tarballFilename);
  const tarballPackage = await readTarballPackageJson(tarballPath);
  const declaredDependencySections = ["dependencies", "optionalDependencies", "peerDependencies"];

  if (profileName === "json-only") {
    for (const section of declaredDependencySections) {
      if (tarballPackage[section]?.["better-sqlite3"] !== undefined) {
        throw new Error(`JSON-only tarball package.json declares better-sqlite3 in ${section}.`);
      }
    }
    if (tarballPackage.routeledgerRuntime?.sqliteReadModel !== "disabled") {
      throw new Error("JSON-only tarball metadata does not require sqliteReadModel=disabled.");
    }
  }

  const installDir = path.join(tmpRoot, "install");
  const workspaceRoot = path.join(tmpRoot, "workspace");
  const routeledgerRoot = path.join(workspaceRoot, "routeledger");

  await fs.mkdir(installDir, { recursive: true });
  await fs.mkdir(routeledgerRoot, { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, ".routeledger"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".routeledger", "config.json"),
    `${JSON.stringify({ version: 1, dataDir: "routeledger" }, null, 2)}\n`,
    "utf8"
  );

  try {
    run(npmCommand, ["init", "-y"], { cwd: installDir });
    const installArgs =
      profileName === "json-only"
        ? ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tarballPath]
        : ["install", "--silent", tarballPath];
    run(
      npmCommand,
      installArgs,
      { cwd: installDir }
    );

    const installedPackageJson = await fs.readFile(
      path.join(installDir, "node_modules/@routeledger/mcp/package.json"),
      "utf8"
    );

    if (installedPackageJson.includes("workspace:")) {
      throw new Error("Installed tarball still contains workspace: dependencies.");
    }

    if (profileName === "json-only") {
      if (await containsDirectoryNamed(path.join(installDir, "node_modules"), "better-sqlite3")) {
        throw new Error("JSON-only install tree unexpectedly contains better-sqlite3.");
      }
      await assertJsonOnlyEntryRequiresDisabled(installDir);
    }

    await assertDirectImportProfile({
      installDir,
      workspaceRoot,
      routeledgerRoot,
      sqliteReadModel,
      profileName
    });

    const { runtimeContext, initialized } = await runStdioSmoke({
      installDir,
      workspaceRoot,
      routeledgerRoot,
      sqliteReadModel,
      profileName
    });
    await assertPackagedIdempotencyRestart({
      installDir,
      workspaceRoot,
      routeledgerRoot,
      sqliteReadModel,
      initialized
    });

    if (profileName === "json-only") {
      const canonicalJsonPath = path.join(routeledgerRoot, ".routeledger", "project.json");
      const sqliteDbPath = path.join(routeledgerRoot, ".routeledger", "db", "routeledger.sqlite3");
      if (!(await fs.stat(canonicalJsonPath).catch(() => null))) {
        throw new Error("JSON-only configure_project(operation=initialize) did not create canonical JSON.");
      }
      if (await fs.stat(sqliteDbPath).catch(() => null)) {
        throw new Error("JSON-only configure_project(operation=initialize) unexpectedly created a SQLite database.");
      }
      if (runtimeContext?.storage?.mode !== "json") {
        throw new Error("JSON-only runtime context did not report storage mode=json.");
      }
      await assertJsonOnlyArtifactTree(artifactDir);
    }

    console.log(
      `Packaged ${profileName} MCP tarball smoke passed: artifact=${artifactDir} tarball=${tarballPath}`
    );
  } finally {
    if (previousXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdgStateHome;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
};

await main();
