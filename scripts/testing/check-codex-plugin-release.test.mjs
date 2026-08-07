import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isResolvableCommit } from "../check-codex-plugin-release.mjs";

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
} finally {
  await fs.rm(repositoryRoot, { recursive: true, force: true });
}
