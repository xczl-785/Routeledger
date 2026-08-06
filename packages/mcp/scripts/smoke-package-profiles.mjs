/* global console, process */

import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageDir, "../..");

const profiles = {
  full: {
    artifactDir: path.join(packageDir, "dist"),
    smokeArgs: [],
    expectedRuntime: {
      buildProfile: "full",
      mode: "json+sqlite",
      sqliteReadModel: "enabled"
    }
  },
  "json-only": {
    artifactDir: path.join(packageDir, "dist-plugin-runtime"),
    smokeArgs: ["--profile", "json-only"],
    expectedRuntime: {
      buildProfile: "json-only",
      mode: "json",
      sqliteReadModel: "disabled"
    }
  }
};

const runSmoke = (profileName) => {
  execFileSync(
    process.execPath,
    [path.join(scriptDir, "smoke-package.mjs"), ...profiles[profileName].smokeArgs],
    {
      cwd: repoRoot,
      stdio: "inherit"
    }
  );
};

const assertArtifact = async (profileName) => {
  const profile = profiles[profileName];
  const packageJson = JSON.parse(
    await fs.readFile(path.join(profile.artifactDir, "package.json"), "utf8")
  );

  if (JSON.stringify(packageJson.routeledgerRuntime) !== JSON.stringify(profile.expectedRuntime)) {
    throw new Error(`Unexpected ${profileName} artifact runtime metadata.`);
  }

  if (profileName === "json-only") {
    const entries = await fs.readdir(profile.artifactDir);
    const declaredEntries = new Set(packageJson.files.map((entry) => entry.replace(/\/$/, "")));
    declaredEntries.add("package.json");
    const unexpectedEntries = entries.filter((entry) => !declaredEntries.has(entry));
    if (unexpectedEntries.length > 0) {
      throw new Error(
        `JSON-only artifact has unexpected final entries: ${unexpectedEntries.join(", ")}`
      );
    }
  }
};

const main = async () => {
  for (const order of [["json-only", "full"], ["full", "json-only"]]) {
    for (const profileName of order) {
      runSmoke(profileName);
    }
    await Promise.all(Object.keys(profiles).map(assertArtifact));
    console.log(`MCP package profile coexistence passed: ${order.join(" -> ")}`);
  }
};

await main();
