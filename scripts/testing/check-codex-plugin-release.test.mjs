import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isResolvableCommit } from "../check-codex-plugin-release.mjs";
import { isReusableCleanBuildCommit } from "../runtime-build-provenance.mjs";

const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-release-check-"));
try {
  run("git", ["init", "--quiet"], repositoryRoot);
  run("git", ["config", "user.email", "release-check@example.test"], repositoryRoot);
  run("git", ["config", "user.name", "Release Check"], repositoryRoot);
  await fs.writeFile(path.join(repositoryRoot, "fixture.txt"), "fixture\n", "utf8");
  run("git", ["add", "fixture.txt"], repositoryRoot);
  run("git", ["commit", "--quiet", "-m", "fixture"], repositoryRoot);
  const commit = run("git", ["rev-parse", "HEAD"], repositoryRoot);
  const tree = run("git", ["rev-parse", "HEAD^{tree}"], repositoryRoot);
  const blob = run("git", ["rev-parse", "HEAD:fixture.txt"], repositoryRoot);

  assert.equal(isResolvableCommit(repositoryRoot, commit), true);
  assert.equal(isResolvableCommit(repositoryRoot, tree), false);
  assert.equal(isResolvableCommit(repositoryRoot, blob), false);
  assert.equal(isResolvableCommit(repositoryRoot, "does-not-exist"), false);
  assert.equal(isResolvableCommit(repositoryRoot, null), false);

  await fs.mkdir(path.join(repositoryRoot, "plugins", "routeledger"), { recursive: true });
  await fs.writeFile(path.join(repositoryRoot, "plugins", "routeledger", "release.json"), "{}\n", "utf8");
  run("git", ["add", "plugins/routeledger/release.json"], repositoryRoot);
  run("git", ["commit", "--quiet", "-m", "generated release metadata"], repositoryRoot);
  const generatedHead = run("git", ["rev-parse", "HEAD"], repositoryRoot);
  assert.equal(isReusableCleanBuildCommit({ repositoryRoot, buildCommit: commit, headCommit: generatedHead }), true);

  await fs.writeFile(path.join(repositoryRoot, "fixture.txt"), "changed source\n", "utf8");
  run("git", ["add", "fixture.txt"], repositoryRoot);
  run("git", ["commit", "--quiet", "-m", "source change"], repositoryRoot);
  assert.equal(isReusableCleanBuildCommit({ repositoryRoot, buildCommit: commit }), false);
  assert.equal(isReusableCleanBuildCommit({ repositoryRoot, buildCommit: "does-not-exist" }), false);
} finally {
  await fs.rm(repositoryRoot, { recursive: true, force: true });
}
