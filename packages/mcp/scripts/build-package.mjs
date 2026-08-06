/* global console, process */

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageDir, "../..");
const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

const buildProfiles = {
  full: {
    outputDirectory: "dist",
    description:
      "RouteLedger MCP stdio server local package-prep artifact. Not a published registry release.",
    includeSqliteRuntime: true,
    sqliteReadModel: "enabled",
    runtimeDirectories: ["codex", "core", "json", "mcp", "sqlite", "ui"]
  },
  "json-only": {
    outputDirectory: "dist-plugin-runtime",
    description:
      "RouteLedger MCP stdio server JSON-only plugin runtime artifact. Start with --sqlite-read-model disabled.",
    includeSqliteRuntime: false,
    sqliteReadModel: "disabled",
    runtimeDirectories: ["codex", "core", "json", "mcp"]
  }
};

const resolveBuildOptions = (argv) => {
  let profileName = "full";
  let outputDirectory;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") {
      profileName = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (argument === "--out-dir") {
      outputDirectory = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown build-package argument: ${argument}`);
  }

  const profile = buildProfiles[profileName];
  if (profile === undefined) {
    throw new Error(`Unsupported MCP package build profile: ${profileName}`);
  }

  const requestedOutputDirectory = outputDirectory ?? profile.outputDirectory;
  if (requestedOutputDirectory.length === 0 || path.isAbsolute(requestedOutputDirectory)) {
    throw new Error("--out-dir must be a non-empty path relative to packages/mcp.");
  }

  const outDir = path.resolve(packageDir, requestedOutputDirectory);
  const relativeOutDir = path.relative(packageDir, outDir);
  if (relativeOutDir === "" || relativeOutDir.startsWith("..") || path.isAbsolute(relativeOutDir)) {
    throw new Error("--out-dir must stay inside packages/mcp.");
  }

  return { profileName, profile, outDir };
};

const topLevelMcpFiles = [
  "binding-assist.js",
  "binding-preflight.js",
  "binding.js",
  "debug-log.js",
  "input-adapter.js",
  "physical-path.js",
  "storage-paths.js",
  "workspace-config.js"
];

const toRelativeImport = (fromFile, toFile) => {
  const relativePath = path.relative(path.dirname(fromFile), toFile).replaceAll(path.sep, "/");
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
};

const createWorkspaceEntryTargets = (outDir) => ({
  "@routeledger/codex": path.join(outDir, "codex/src/index.js"),
  "@routeledger/core": path.join(outDir, "core/src/index.js"),
  "@routeledger/json": path.join(outDir, "json/src/index.js"),
  "@routeledger/sqlite": path.join(outDir, "sqlite/src/index.js")
});

const createEmittedWorkspaceRelativeTargets = (outDir) => ({
  "../../codex/src/index.js": path.join(outDir, "codex/src/index.js"),
  "../../core/src/index.js": path.join(outDir, "core/src/index.js"),
  "../../json/src/index.js": path.join(outDir, "json/src/index.js"),
  "../../sqlite/src/index.js": path.join(outDir, "sqlite/src/index.js")
});

const renderReadme = ({ version, profileName, profile }) => `# @routeledger/mcp

Local ${profileName} artifact for the RouteLedger MCP stdio server.

## Status

- This artifact is generated locally from the RouteLedger workspace.
- It is not a published npm package and should not be documented as registry-ready.
- Internal RouteLedger workspace packages are compiled into the dist artifact.
${
  profile.includeSqliteRuntime
    ? "- `better-sqlite3` remains an external runtime dependency and still needs clean-machine validation on macOS, Windows, and Linux before any real release."
    : "- This JSON-only artifact has no `better-sqlite3` dependency and carries neither SQLite nor UI runtime bundles. It must be started with `--sqlite-read-model disabled`; its entry rejects a missing or different value."
}

## Build

\`\`\`bash
cd /ABS/PATH/TO/ROUTELEDGER_REPO_ROOT
pnpm ${profileName === "full" ? "build:mcp-package" : "build:mcp-plugin-runtime"}
\`\`\`

The generated package version is \`${version}\`.

## Local tarball smoke

\`\`\`bash
cd /ABS/PATH/TO/ROUTELEDGER_REPO_ROOT
pnpm ${profileName === "full" ? "smoke:mcp-package" : "smoke:mcp-plugin-runtime"}
\`\`\`

That smoke flow builds the generated artifact, runs \`npm pack\`, installs the tarball into a temporary directory, and verifies \`initialize -> tools/list\` against temporary workspace and RouteLedger roots.

## Host usage after local install

Example command:

\`\`\`bash
node /ABS/PATH/TO/install-root/node_modules/@routeledger/mcp/bin.js \\
  --workspace-root /ABS/PATH/TO/MANAGED_WORKSPACE_ROOT \\
  --routeledger-root /ABS/PATH/TO/MANAGED_WORKSPACE_ROOT \\
  --profile codex${profile.sqliteReadModel === "disabled" ? " \\\n  --sqlite-read-model disabled" : ""}
\`\`\`

Keep \`--workspace-root\` and \`--routeledger-root\` explicit. Do not rely on \`cwd\` fallback.
`;

const rewriteWorkspaceImports = async (filePath, version, outDir) => {
  let content = await fs.readFile(filePath, "utf8");

  for (const [specifier, targetPath] of Object.entries(createWorkspaceEntryTargets(outDir))) {
    const replacement = toRelativeImport(filePath, targetPath);
    content = content.replaceAll(`"${specifier}"`, `"${replacement}"`);
    content = content.replaceAll(`'${specifier}'`, `'${replacement}'`);
  }

  for (const [specifier, targetPath] of Object.entries(
    createEmittedWorkspaceRelativeTargets(outDir)
  )) {
    const replacement = toRelativeImport(filePath, targetPath);
    content = content.replaceAll(`"${specifier}"`, `"${replacement}"`);
    content = content.replaceAll(`'${specifier}'`, `'${replacement}'`);
  }

  content = content.replaceAll('"0.0.0-d3.6"', JSON.stringify(version));

  if (path.basename(filePath) === "bin.js" && content.startsWith("#!/usr/bin/env tsx")) {
    content = content.replace("#!/usr/bin/env tsx", "#!/usr/bin/env node");
  }

  await fs.writeFile(filePath, content);
};

const collectJsFiles = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }

  return files;
};

const pruneArtifactToRuntimeAllowlist = async (outDir, runtimeDirectories) => {
  const allowedDirectories = new Set(runtimeDirectories);
  const entries = await fs.readdir(outDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !allowedDirectories.has(entry.name))
      .map((entry) => fs.rm(path.join(outDir, entry.name), { recursive: true, force: true }))
  );
};

const renderJsonOnlyBin = () => `#!/usr/bin/env node
const sqliteReadModelFlag = "--sqlite-read-model";
const flagIndex = process.argv.indexOf(sqliteReadModelFlag);

if (flagIndex === -1 || process.argv[flagIndex + 1] !== "disabled") {
  process.stderr.write(
    "@routeledger/mcp JSON-only artifact requires --sqlite-read-model disabled.\\n"
  );
  process.exitCode = 2;
} else {
  await import("./mcp/src/bin.js");
}
`;

const main = async () => {
  const { profileName, profile, outDir } = resolveBuildOptions(process.argv.slice(2));
  const sourcePackage = JSON.parse(
    await fs.readFile(path.join(packageDir, "package.json"), "utf8")
  );
  const rootPackage = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const version = sourcePackage.version;

  await fs.rm(outDir, { recursive: true, force: true });

  execFileSync(
    process.execPath,
    [
      tscPath,
      "-p",
      "packages/mcp/tsconfig.package.json",
      "--pretty",
      "false",
      "--newLine",
      "lf",
      "--outDir",
      outDir
    ],
    {
      cwd: repoRoot,
      stdio: "inherit"
    }
  );

  await fs.copyFile(path.join(outDir, "mcp/src/index.js"), path.join(outDir, "index.js"));
  if (profileName === "json-only") {
    await fs.writeFile(path.join(outDir, "bin.js"), renderJsonOnlyBin());
  } else {
    await fs.copyFile(path.join(outDir, "mcp/src/bin.js"), path.join(outDir, "bin.js"));
  }
  await fs.copyFile(
    path.join(outDir, "mcp/src/stdio-server.js"),
    path.join(outDir, "stdio-server.js")
  );
  await fs.copyFile(
    path.join(outDir, "mcp/src/json-first-storage.js"),
    path.join(outDir, "json-first-storage.js")
  );
  await Promise.all(
    topLevelMcpFiles.map((fileName) =>
      fs.copyFile(path.join(outDir, "mcp/src", fileName), path.join(outDir, fileName))
    )
  );

  await pruneArtifactToRuntimeAllowlist(outDir, profile.runtimeDirectories);

  const jsFiles = await collectJsFiles(outDir);
  await Promise.all(jsFiles.map((filePath) => rewriteWorkspaceImports(filePath, version, outDir)));
  await fs.chmod(path.join(outDir, "bin.js"), 0o755);

  const distPackage = {
    name: sourcePackage.name,
    version,
    description: profile.description,
    license: sourcePackage.license,
    type: "module",
    main: "./index.js",
    exports: {
      ".": "./index.js"
    },
    bin: {
      "routeledger-mcp-stdio": "./bin.js"
    },
    engines: {
      node: ">=18"
    },
    files: [
      "bin.js",
      "binding-assist.js",
      "binding-preflight.js",
      "binding.js",
      "debug-log.js",
      "index.js",
      "input-adapter.js",
      "physical-path.js",
      "storage-paths.js",
      "stdio-server.js",
      "workspace-config.js",
      "json-first-storage.js",
      "codex/",
      "core/",
      "json/",
      "mcp/",
      "README.md"
    ],
    routeledgerRuntime: {
      buildProfile: profileName,
      mode: profileName === "json-only" ? "json" : "json+sqlite",
      sqliteReadModel: profile.sqliteReadModel
    }
  };

  if (profile.includeSqliteRuntime) {
    distPackage.files.splice(distPackage.files.indexOf("README.md"), 0, "sqlite/");
    distPackage.dependencies = {
      "better-sqlite3": rootPackage.devDependencies["better-sqlite3"]
    };
  }

  await fs.writeFile(
    path.join(outDir, "package.json"),
    `${JSON.stringify(distPackage, null, 2)}\n`
  );
  await fs.writeFile(path.join(outDir, "README.md"), renderReadme({ version, profileName, profile }));

  console.log(`Built ${profileName} MCP runtime artifact in ${outDir}`);
};

await main();
