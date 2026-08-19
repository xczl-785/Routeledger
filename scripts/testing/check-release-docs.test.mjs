/* global console, process */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sourceRoot = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-release-docs-"));

const write = async (relativePath, content) => {
  const target = path.join(fixtureRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
};

const writeReleaseSurface = async (version, releaseNote) => {
  const tag = `routeledger-plugin-v${version}`;
  await write("README.md", `已发布稳定版为 ${version}\n[${version} release note](docs/release/release-notes/${version}.md)\n`);
  await write("docs/release/release-policy.md", `version ${version} is the latest published\n${tag}\n`);
  await write("docs/release/plugin-release.md", `latest published plugin release is \`${tag}\`\n`);
  await write(
    "docs/release/distribution-and-tags.md",
    `[${version}](release-notes/${version}.md)\nPublished: Codex plugin ${version} (tag \`${tag}\`)\n`
  );
  await write("docs/release/release-notes/0.9.4.md", "published baseline\n");
  await write(`docs/release/release-notes/${version}.md`, releaseNote);
};

await fs.mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
await fs.copyFile(path.join(sourceRoot, "scripts/check-release-docs.mjs"), path.join(fixtureRoot, "scripts/check-release-docs.mjs"));
await write("plugins/routeledger/.codex-plugin/plugin.json", JSON.stringify({ version: "0.10.0" }));
await writeReleaseSurface("0.9.4", "published baseline\n");
execFileSync("git", ["init", "-q"], { cwd: fixtureRoot });
execFileSync("git", ["config", "user.name", "RouteLedger Test"], { cwd: fixtureRoot });
execFileSync("git", ["config", "user.email", "routeledger-test@example.invalid"], { cwd: fixtureRoot });
execFileSync("git", ["add", "."], { cwd: fixtureRoot });
execFileSync("git", ["commit", "-qm", "baseline"], { cwd: fixtureRoot });
execFileSync("git", ["tag", "routeledger-plugin-v0.9.4"], { cwd: fixtureRoot });

const run = () =>
  spawnSync(process.execPath, ["scripts/check-release-docs.mjs"], {
    cwd: fixtureRoot,
    encoding: "utf8"
  });

assert.equal(run().status, 0, "the current published baseline should pass");

await writeReleaseSurface(
  "0.10.0",
  "The release is fixed by immutable tag `routeledger-plugin-v0.10.0` on `main`.\n"
);
assert.equal(run().status, 0, "one consistent staged release should pass before its tag exists");

await write("README.md", "已发布稳定版为 0.9.4\n[0.10.0 release note](docs/release/release-notes/0.10.0.md)\n");
const mixed = run();
assert.notEqual(mixed.status, 0, "a mixed release baseline must fail");
assert.match(mixed.stderr, /does not consistently identify/);

await fs.rm(fixtureRoot, { recursive: true, force: true });
console.log("Release documentation staged-version checks passed.");
