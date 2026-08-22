/* global process */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");

execFileSync(
  process.execPath,
  [path.join(scriptDir, "check-codex-plugin-release.mjs"), ...process.argv.slice(2)],
  { cwd: repositoryRoot, stdio: "inherit" }
);
execFileSync(process.execPath, [path.join(scriptDir, "check-release-docs.mjs")], {
  cwd: repositoryRoot,
  stdio: "inherit"
});
