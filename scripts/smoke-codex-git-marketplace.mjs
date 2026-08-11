/* global Buffer, console, process */

/**
 * A hermetic black-box smoke for Codex's Git marketplace implementation.
 *
 * It deliberately does not use a file:// remote: Git-over-HTTP exercises the
 * transport Codex uses for a normal remote marketplace while keeping every
 * checkout, cache, HOME, and fixture repository below one temporary root.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const routeledgerRoot = path.resolve(scriptDir, "..");
const repositoryRoot = routeledgerRoot;
const sourcePluginRoot = path.join(repositoryRoot, "plugins", "routeledger");
const pluginName = "routeledger";
const marketplaceName = "routeledger-team";
const releaseBranch = "main";
const baselineVersion = "0.3.3";
const upgradedVersion = "0.6.0";
const baselineTag = "routeledger-plugin-v0.3.3";
const fixtureAttributes = "plugins/routeledger/** -text\n";
const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";
const codexCliJs = process.env.CODEX_CLI_JS?.trim();
const gitCommand = process.platform === "win32" ? "git.exe" : "git";

const fail = (message) => {
  throw new Error(`Codex Git marketplace smoke: ${message}`);
};

const exists = async (target) => Boolean(await fs.stat(target).catch(() => null));

const run = async (command, args, options = {}) => {
  try {
    return await execFileAsync(command, args, {
      cwd: routeledgerRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...options
    });
  } catch (error) {
    const stdout = error.stdout ? `\nstdout:\n${error.stdout}` : "";
    const stderr = error.stderr ? `\nstderr:\n${error.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed (${error.code ?? "unknown"})${stdout}${stderr}`);
  }
};

const parseJson = (stdout, description) => {
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`${description} did not emit JSON:\n${stdout}`);
  }
};

const commandAvailable = async (command, commandPrefix = []) => {
  try {
    await run(command, [...commandPrefix, "--version"]);
    return true;
  } catch {
    return false;
  }
};

const codexInvocation = (args) =>
  codexCliJs
    ? { command: process.execPath, args: [codexCliJs, ...args], description: `CODEX_CLI_JS (${codexCliJs})` }
    : { command: codexCommand, args, description: `codex (${codexCommand})` };

const runCodex = (args, options = {}) => {
  const invocation = codexInvocation(args);
  return run(invocation.command, invocation.args, options);
};

const assertPrerequisites = async () => {
  const missing = [];
  if (!(await commandAvailable(gitCommand))) missing.push(`git (${gitCommand})`);
  if (codexCliJs) {
    if (!(await fs.stat(codexCliJs).catch(() => null))) {
      missing.push(`CODEX_CLI_JS (${codexCliJs})`);
    } else if (!(await commandAvailable(process.execPath, [codexCliJs]))) {
      missing.push(`CODEX_CLI_JS (${codexCliJs})`);
    }
  } else if (process.platform === "win32") {
    missing.push("CODEX_CLI_JS (set it to @openai/codex/bin/codex.js; do not invoke codex.cmd through Node)");
  } else if (!(await commandAvailable(codexCommand))) {
    missing.push(`codex (${codexCommand})`);
  }
  if (missing.length > 0) {
    fail(`required executable unavailable: ${missing.join(", ")}. Install Git and Codex CLI, then retry.`);
  }
  const { stdout } = await runCodex(["plugin", "marketplace", "add", "--help"]);
  if (!stdout.includes("--ref")) {
    fail("installed Codex CLI does not expose Git marketplace --ref support.");
  }
};

const toPortablePath = (target) => target.split(path.sep).join("/");

const collectRelativeFiles = async (root, relativeRoot = "") => {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const relativePath = path.posix.join(relativeRoot, entry.name);
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectRelativeFiles(target, relativePath)));
    else if (entry.isFile()) files.push({ absolutePath: target, relativePath: toPortablePath(relativePath) });
  }
  return files;
};

const hashFileSet = async (root, shouldInclude = () => true) => {
  const files = (await collectRelativeFiles(root)).filter(({ relativePath }) => shouldInclude(relativePath));
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const hash = crypto.createHash("sha256");
  for (const { absolutePath, relativePath } of files) {
    const content = await fs.readFile(absolutePath);
    hash.update(Buffer.from(relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(content.length), "ascii"));
    hash.update(Buffer.from([0]));
    hash.update(content);
  }
  return hash.digest("hex");
};

const createMarketplaceCatalog = () => ({
  name: marketplaceName,
  interface: { displayName: "RouteLedger Team" },
  plugins: [
    {
      name: pluginName,
      source: { source: "local", path: "./plugins/routeledger" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity"
    }
  ]
});

const writeFixtureRelease = async (workingRoot, version) => {
  const fixturePluginRoot = path.join(workingRoot, "plugins", pluginName);
  const manifestPath = path.join(fixturePluginRoot, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.name !== pluginName) {
    fail(`source plugin manifest name must be ${pluginName}; received ${manifest.name ?? "missing"}.`);
  }
  manifest.version = version;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const catalogPath = path.join(workingRoot, ".agents", "plugins", "marketplace.json");
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  await fs.writeFile(catalogPath, `${JSON.stringify(createMarketplaceCatalog(), null, 2)}\n`);
  const [pluginDistributionSha256, runtimeSha256] = await Promise.all([
    hashFileSet(fixturePluginRoot, (relativePath) => relativePath !== "release.json"),
    hashFileSet(path.join(fixturePluginRoot, "runtime"))
  ]);
  const release = {
    schemaVersion: 1,
    marketplace: { name: marketplaceName, displayName: "RouteLedger Team" },
    plugin: { name: pluginName, version },
    content: {
      algorithm: "sha256",
      pluginDistributionSha256,
      runtimeSha256,
      pluginDistributionCoverage: "All regular files under plugins/routeledger, excluding release.json.",
      runtimeCoverage: "All regular files under plugins/routeledger/runtime."
    }
  };
  await fs.writeFile(path.join(fixturePluginRoot, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  return { pluginRoot: fixturePluginRoot, version, pluginDistributionSha256, runtimeSha256 };
};

const git = (args, options) => run(gitCommand, args, options);

const createFixtureRepository = async (temporaryRoot) => {
  const workingRoot = path.join(temporaryRoot, "fixture-working");
  const remoteRoot = path.join(temporaryRoot, "git-projects");
  const bareRoot = path.join(remoteRoot, "routeledger.git");
  await fs.mkdir(workingRoot, { recursive: true });
  await fs.mkdir(path.join(workingRoot, "plugins"), { recursive: true });
  await fs.writeFile(path.join(workingRoot, ".gitattributes"), fixtureAttributes, "utf8");
  await fs.cp(sourcePluginRoot, path.join(workingRoot, "plugins", pluginName), { recursive: true, force: true });
  const baseline = await writeFixtureRelease(workingRoot, baselineVersion);
  await git(["init"], { cwd: workingRoot });
  await git(["config", "user.email", "routeledger-smoke@example.invalid"], { cwd: workingRoot });
  await git(["config", "user.name", "RouteLedger Git Marketplace Smoke"], { cwd: workingRoot });
  await git(["add", "."], { cwd: workingRoot });
  await git(["commit", "-m", `fixture release ${baselineVersion}`], { cwd: workingRoot });
  await git(["branch", "-M", releaseBranch], { cwd: workingRoot });
  await git(["tag", "-a", baselineTag, "-m", `fixture release ${baselineVersion}`], { cwd: workingRoot });
  await fs.mkdir(remoteRoot, { recursive: true });
  await git(["init", "--bare", bareRoot]);
  await git(["remote", "add", "origin", bareRoot], { cwd: workingRoot });
  await git(["push", "origin", releaseBranch, "--tags"], { cwd: workingRoot });
  return { workingRoot, remoteRoot, bareRoot, baseline };
};

const startGitHttpServer = async (projectRoot) => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const child = spawn(gitCommand, ["http-backend"], {
      env: {
        ...process.env,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_PROJECT_ROOT: projectRoot,
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
        REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
        REMOTE_USER: ""
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let headerBuffer = Buffer.alloc(0);
    let headersSent = false;
    const sendHeaders = () => {
      const separator = headerBuffer.indexOf("\r\n\r\n");
      const alternateSeparator = headerBuffer.indexOf("\n\n");
      const end = separator >= 0 ? separator : alternateSeparator;
      if (end < 0) return false;
      const length = separator >= 0 ? 4 : 2;
      const headerText = headerBuffer.subarray(0, end).toString("utf8");
      const headers = {};
      let statusCode = 200;
      for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") statusCode = Number.parseInt(value, 10) || 500;
        else headers[key] = value;
      }
      response.writeHead(statusCode, headers);
      response.write(headerBuffer.subarray(end + length));
      headerBuffer = Buffer.alloc(0);
      headersSent = true;
      return true;
    };
    request.pipe(child.stdin);
    child.stdout.on("data", (chunk) => {
      if (headersSent) response.write(chunk);
      else {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        sendHeaders();
      }
    });
    child.stderr.on("data", (chunk) => console.error(`git http-backend: ${chunk}`));
    child.on("error", (error) => {
      if (!headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(`git http-backend failed: ${error.message}`);
    });
    child.on("close", (code) => {
      if (!headersSent) {
        response.writeHead(code === 0 ? 200 : 500, { "content-type": "text/plain" });
        response.write(headerBuffer);
      }
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("local Git HTTP server did not bind a TCP port.");
  return {
    url: `http://127.0.0.1:${address.port}/routeledger.git`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
};

const codexEnvironment = (temporaryRoot) => {
  const home = path.join(temporaryRoot, "home");
  const codexHome = path.join(temporaryRoot, "codex-home");
  return {
    home,
    codexHome,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: path.parse(home).root,
      HOMEPATH: path.relative(path.parse(home).root, home),
      CODEX_HOME: codexHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0"
    }
  };
};

const runCodexJson = async (environment, args) => {
  const { stdout } = await runCodex([...args, "--json"], { env: environment.env, cwd: environment.home });
  return parseJson(stdout, `codex ${args.join(" ")}`);
};

const findPluginRoots = async (root, version) => {
  const roots = [];
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name === "plugin.json" && path.basename(path.dirname(target)) === ".codex-plugin") {
        const manifest = JSON.parse(await fs.readFile(target, "utf8").catch(() => "{}"));
        if (manifest.name === pluginName && manifest.version === version) roots.push(path.dirname(path.dirname(target)));
      }
    }
  };
  await walk(root);
  return roots;
};

const assertReleaseMetadata = async (pluginRoot, expected) => {
  const [manifest, release] = await Promise.all(
    [path.join(pluginRoot, ".codex-plugin", "plugin.json"), path.join(pluginRoot, "release.json")].map(async (target) =>
      JSON.parse(await fs.readFile(target, "utf8"))
    )
  );
  if (
    manifest.name !== pluginName ||
    manifest.version !== expected.version ||
    release.schemaVersion !== 1 ||
    release.marketplace?.name !== marketplaceName ||
    release.marketplace?.displayName !== "RouteLedger Team" ||
    release.plugin?.name !== pluginName ||
    release.plugin?.version !== expected.version ||
    release.content?.algorithm !== "sha256" ||
    release.content?.pluginDistributionCoverage !== "All regular files under plugins/routeledger, excluding release.json." ||
    release.content?.runtimeCoverage !== "All regular files under plugins/routeledger/runtime."
  ) {
    fail(`invalid release metadata at ${pluginRoot} for ${pluginName}@${expected.version}.`);
  }
  const [pluginDistributionSha256, runtimeSha256] = await Promise.all([
    hashFileSet(pluginRoot, (relativePath) => relativePath !== "release.json"),
    hashFileSet(path.join(pluginRoot, "runtime"))
  ]);
  if (
    release.content.pluginDistributionSha256 !== pluginDistributionSha256 ||
    release.content.runtimeSha256 !== runtimeSha256 ||
    release.content.pluginDistributionSha256 !== expected.pluginDistributionSha256 ||
    release.content.runtimeSha256 !== expected.runtimeSha256
  ) {
    fail(`release metadata hash mismatch at ${pluginRoot} for ${pluginName}@${expected.version}.`);
  }
};

const findInstalledPluginRoot = async (environment, expected) => {
  const candidates = await findPluginRoots(environment.codexHome, expected.version);
  for (const candidate of candidates) await assertReleaseMetadata(candidate, expected);
  if (candidates.length < 2) {
    fail(`expected both marketplace snapshot and installed cache for ${expected.version}; found ${candidates.length} matching plugin roots under isolated CODEX_HOME.`);
  }
  const installedCacheSegment = `${path.sep}plugins${path.sep}cache${path.sep}`;
  const installed = candidates.find((candidate) => candidate.includes(installedCacheSegment));
  if (!installed) {
    fail(`could not distinguish the installed plugin cache from marketplace snapshots: ${candidates.join(", ")}`);
  }
  return installed;
};

const assertCodexConfig = async (environment, expected) => {
  const configPath = path.join(environment.codexHome, "config.toml");
  const config = await fs.readFile(configPath, "utf8").catch(() => "");
  for (const value of expected) {
    if (!config.includes(value)) fail(`isolated Codex config does not contain expected value ${JSON.stringify(value)}.`);
  }
};

const assertInstalledListing = async (environment, expectedVersion) => {
  const listing = await runCodexJson(environment, ["plugin", "list"]);
  const installedEntries = Array.isArray(listing?.installed) ? listing.installed : [];
  if (
    !installedEntries.some(
      (plugin) =>
        plugin.pluginId === `${pluginName}@${marketplaceName}` &&
        plugin.version === expectedVersion &&
        plugin.installed === true
    )
  ) {
    fail(`codex plugin list did not report ${pluginName}@${marketplaceName} ${expectedVersion} as installed.`);
  }
};

const runInstalledRuntimeSmoke = async (installedPluginRoot, temporaryRoot, releaseStage) => {
  const testWorkspaceRoot = path.join(temporaryRoot, `runtime-workspace-${releaseStage}`);
  const testRouteledgerRoot = path.join(testWorkspaceRoot, "routeledger");
  await fs.mkdir(path.join(testWorkspaceRoot, ".routeledger"), { recursive: true });
  await fs.mkdir(testRouteledgerRoot, { recursive: true });
  await fs.writeFile(path.join(testWorkspaceRoot, ".routeledger", "config.json"), `${JSON.stringify({ version: 1, dataDir: "routeledger" })}\n`);
  const child = spawn(process.execPath, ["./runtime/bin.js", "--profile", "codex", "--sqlite-read-model", "disabled"], {
    cwd: installedPluginRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const write = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  write({ jsonrpc: "2.0", id: "initialize", method: "initialize", params: { protocolVersion: "2025-11-25", rootUri: pathToFileURL(testWorkspaceRoot).href, capabilities: {}, clientInfo: { name: "routeledger-git-marketplace-smoke", version: "1" } } });
  write({ jsonrpc: "2.0", method: "notifications/initialized" });
  write({ jsonrpc: "2.0", id: "tools-list", method: "tools/list", params: {} });
  write({ jsonrpc: "2.0", id: "init-project", method: "tools/call", params: { name: "init_project", arguments: { name: "Git Marketplace Smoke", contentLocale: "en", expectedRouteLedgerRoot: testRouteledgerRoot } } });
  write({ jsonrpc: "2.0", id: "runtime-context", method: "tools/call", params: { name: "get_runtime_context", arguments: {} } });
  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
  const stderrText = Buffer.concat(stderr).toString("utf8");
  const responses = Buffer.concat(stdout).toString("utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  if (exitCode !== 0 || stderrText !== "" || responses.length !== 4) fail(`installed runtime smoke failed (exit=${exitCode}, responses=${responses.length}): ${stderrText}`);
  const context = responses[3]?.result?.structuredContent?.data;
  if (responses[0]?.result?.protocolVersion !== "2025-11-25" || !Array.isArray(responses[1]?.result?.tools) || responses[2]?.result?.structuredContent?.ok !== true) fail("installed runtime did not complete initialize/tools-list/init_project.");
  if (context?.binding?.workspaceRoot !== testWorkspaceRoot || context?.binding?.routeledgerRoot !== testRouteledgerRoot || context?.storage?.mode !== "json" || context?.storage?.sqliteReadModel !== "disabled") fail("installed runtime did not preserve canonical JSON-only binding.");
  const projectPath = path.join(testRouteledgerRoot, ".routeledger", "project.json");
  if (!(await exists(projectPath))) fail("installed runtime did not create canonical project JSON.");
  JSON.parse(await fs.readFile(projectPath, "utf8"));
  if (await exists(path.join(testRouteledgerRoot, ".routeledger", "db", "routeledger.sqlite3"))) fail("installed runtime created a SQLite database.");
};

const main = async () => {
  await assertPrerequisites();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-codex-git-marketplace-"));
  let gitServer;
  try {
    const fixture = await createFixtureRepository(temporaryRoot);
    gitServer = await startGitHttpServer(fixture.remoteRoot);
    const environment = codexEnvironment(temporaryRoot);
    await fs.mkdir(environment.home, { recursive: true });
    await fs.mkdir(environment.codexHome, { recursive: true });

    await runCodexJson(environment, ["plugin", "marketplace", "add", gitServer.url, "--ref", releaseBranch]);
    const marketplaces = await runCodexJson(environment, ["plugin", "marketplace", "list"]);
    if (!JSON.stringify(marketplaces).includes(marketplaceName)) fail(`fresh Git marketplace list did not expose ${marketplaceName}.`);
    const available = await runCodexJson(environment, ["plugin", "list", "--marketplace", marketplaceName, "--available"]);
    if (!JSON.stringify(available).includes(pluginName)) fail("fresh Git marketplace plugin list did not expose routeledger.");
    await runCodexJson(environment, ["plugin", "add", `${pluginName}@${marketplaceName}`]);
    await assertInstalledListing(environment, baselineVersion);
    const baselineInstalledRoot = await findInstalledPluginRoot(environment, fixture.baseline);
    await assertCodexConfig(environment, [marketplaceName, gitServer.url, releaseBranch]);
    await runInstalledRuntimeSmoke(baselineInstalledRoot, temporaryRoot, "baseline");

    const upgraded = await writeFixtureRelease(fixture.workingRoot, upgradedVersion);
    await git(["add", "."], { cwd: fixture.workingRoot });
    await git(["commit", "-m", `fixture release ${upgradedVersion}`], { cwd: fixture.workingRoot });
    await git(["push", "origin", releaseBranch], { cwd: fixture.workingRoot });
    await runCodexJson(environment, ["plugin", "marketplace", "upgrade", marketplaceName]);
    await assertInstalledListing(environment, upgradedVersion);
    const upgradedInstalledRoot = await findInstalledPluginRoot(environment, upgraded);
    if (upgradedInstalledRoot === baselineInstalledRoot && fixture.baseline.pluginDistributionSha256 !== upgraded.pluginDistributionSha256) fail("marketplace upgrade did not replace the installed plugin cache root.");
    await runInstalledRuntimeSmoke(upgradedInstalledRoot, temporaryRoot, "upgrade");

    await runCodexJson(environment, ["plugin", "remove", `${pluginName}@${marketplaceName}`]);
    await runCodexJson(environment, ["plugin", "marketplace", "remove", marketplaceName]);
    await runCodexJson(environment, ["plugin", "marketplace", "add", gitServer.url, "--ref", baselineTag]);
    await runCodexJson(environment, ["plugin", "add", `${pluginName}@${marketplaceName}`]);
    await assertInstalledListing(environment, baselineVersion);
    await assertCodexConfig(environment, [marketplaceName, gitServer.url, baselineTag]);
    const rollbackInstalledRoot = await findInstalledPluginRoot(environment, fixture.baseline);
    await runInstalledRuntimeSmoke(rollbackInstalledRoot, temporaryRoot, "rollback");
    console.log("Codex Git marketplace smoke passed: fresh install, automatic upgrade, fixture-tag reinstall, cache hashes, and JSON-only installed runtime.");
  } finally {
    await gitServer?.close().catch(() => undefined);
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
};

await main();
