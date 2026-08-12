/* global process */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hasValidPluginRuntimeIdentity,
  hasValidReleaseContentHashes
} from "../check-codex-plugin-release.mjs";
import { collectRegularFiles } from "../regular-file-tree.mjs";

const digest = "a".repeat(64);
const distributionDigest = "b".repeat(64);
const runtimeDigest = "c".repeat(64);
const repositoryUrl = "https://github.com/xczl-785/Routeledger";
const releaseTag = "routeledger-plugin-v0.3.6";
const assetName = `${releaseTag}-attestation.json`;
const attestation = {
  strategy: "git-tag-external",
  repositoryUrl,
  releaseTag,
  assetName,
  downloadUrl: `${repositoryUrl}/releases/download/${releaseTag}/${assetName}`
};
const identity = {
  runtimePackageVersion: "0.3.6",
  runtimeProfile: "json-only",
  artifactKind: "plugin",
  pluginVersion: "0.3.6",
  releaseTag,
  sourceTreeState: "clean",
  provenanceStatus: "external_attestation_required",
  attestation,
  buildCommit: null,
  artifactDigest: null,
  runtimePayloadDigest: digest
};
const releaseIdentity = {
  ...identity,
  runtimePayloadCoverage: "All regular files under plugins/routeledger/runtime, excluding mcp/src/runtime-identity.js."
};
const content = {
  algorithm: "sha256",
  pluginDistributionSha256: distributionDigest,
  runtimeSha256: runtimeDigest,
  pluginDistributionCoverage: "All regular files under plugins/routeledger, excluding release.json.",
  runtimeCoverage: "All regular files under plugins/routeledger/runtime."
};

assert.equal(hasValidPluginRuntimeIdentity({ runtimeIdentity: identity, releaseIdentity, pluginVersion: "0.3.6", runtimePayloadDigest: digest }), true);
assert.equal(hasValidPluginRuntimeIdentity({ runtimeIdentity: { ...identity, attestation: null }, releaseIdentity, pluginVersion: "0.3.6", runtimePayloadDigest: digest }), false);
assert.equal(hasValidPluginRuntimeIdentity({ runtimeIdentity: identity, releaseIdentity: { ...releaseIdentity, attestation: null }, pluginVersion: "0.3.6", runtimePayloadDigest: digest }), false);
assert.equal(hasValidPluginRuntimeIdentity({ runtimeIdentity: { ...identity, buildCommit: "f".repeat(40) }, releaseIdentity, pluginVersion: "0.3.6", runtimePayloadDigest: digest }), false);
assert.equal(hasValidPluginRuntimeIdentity({ runtimeIdentity: identity, releaseIdentity: { ...releaseIdentity, buildCommit: "f".repeat(40) }, pluginVersion: "0.3.6", runtimePayloadDigest: digest }), false);
assert.equal(hasValidPluginRuntimeIdentity({ runtimeIdentity: { ...identity, runtimePayloadDigest: "d".repeat(64) }, releaseIdentity, pluginVersion: "0.3.6", runtimePayloadDigest: digest }), false);
assert.equal(hasValidPluginRuntimeIdentity({ runtimeIdentity: identity, releaseIdentity: { ...releaseIdentity, runtimePayloadDigest: "d".repeat(64) }, pluginVersion: "0.3.6", runtimePayloadDigest: digest }), false);
assert.equal(hasValidReleaseContentHashes({ releaseContent: content, pluginDistributionSha256: distributionDigest, runtimeSha256: runtimeDigest }), true);
assert.equal(hasValidReleaseContentHashes({ releaseContent: { ...content, runtimeSha256: "d".repeat(64) }, pluginDistributionSha256: distributionDigest, runtimeSha256: runtimeDigest }), false);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const checkerPath = path.join("scripts", "check-codex-plugin-release.mjs");
const run = (command, args, cwd, options = {}) =>
  spawnSync(command, args, { cwd, encoding: "utf8", ...options });
const runOrThrow = (command, args, cwd, options = {}) => {
  const result = run(command, args, cwd, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
};
const assertFailure = (command, args, cwd, expected) => {
  const result = run(command, args, cwd);
  assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly passed.`);
  assert.match(`${result.stderr}${result.stdout}`, expected);
};
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "routeledger-release-check-symlink-"));
try {
  runOrThrow("git", ["clone", "--shared", repositoryRoot, fixtureRoot], repositoryRoot);
  const patch = execFileSync("git", ["diff", "--binary"], { cwd: repositoryRoot, encoding: "buffer" });
  if (patch.length > 0) {
    runOrThrow("git", ["apply", "--whitespace=nowarn"], fixtureRoot, { input: patch });
  }
  await fs.copyFile(
    path.join(repositoryRoot, "scripts", "regular-file-tree.mjs"),
    path.join(fixtureRoot, "scripts", "regular-file-tree.mjs")
  );
  runOrThrow(process.execPath, [checkerPath], fixtureRoot);

  const pluginRoot = path.join(fixtureRoot, "plugins", "routeledger");
  const runtimeRoot = path.join(pluginRoot, "runtime");
  const trySymlink = async (relativePath) => {
    try {
      await fs.symlink(path.join(runtimeRoot, "package.json"), path.join(pluginRoot, relativePath), "file");
      return true;
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) return false;
      throw error;
    }
  };

  if (await trySymlink(path.join("runtime", "runtime-check-link.js"))) {
    assertFailure(process.execPath, [checkerPath], fixtureRoot, /runtime-check-link\.js": symbolic link/);
    await fs.rm(path.join(runtimeRoot, "runtime-check-link.js"));
  }
  if (await trySymlink(path.join("skills", "plugin-check-link"))) {
    assertFailure(process.execPath, [checkerPath], fixtureRoot, /skills\/plugin-check-link": symbolic link/);
    await assert.rejects(() => collectRegularFiles(pluginRoot), /skills\/plugin-check-link": symbolic link/);
    await fs.rm(path.join(pluginRoot, "skills", "plugin-check-link"));
  }

  runOrThrow("git", ["config", "user.email", "release-check@example.test"], fixtureRoot);
  runOrThrow("git", ["config", "user.name", "Release Check"], fixtureRoot);
  runOrThrow("git", ["add", "."], fixtureRoot);
  if (runOrThrow("git", ["status", "--porcelain"], fixtureRoot).trim().length > 0) {
    runOrThrow("git", ["commit", "--quiet", "-m", "valid plugin fixture"], fixtureRoot);
  }
  const baseline = runOrThrow("git", ["rev-parse", "HEAD"], fixtureRoot).trim();
  await fs.writeFile(
    path.join(pluginRoot, "candidate-repair-marker.txt"),
    "synthetic previous candidate bytes\n",
    "utf8"
  );
  runOrThrow("git", ["add", "plugins/routeledger/candidate-repair-marker.txt"], fixtureRoot);
  runOrThrow("git", ["commit", "--quiet", "-m", "synthetic previous candidate"], fixtureRoot);
  runOrThrow("git", ["branch", "previous-candidate"], fixtureRoot);
  runOrThrow("git", ["checkout", "--quiet", "--detach", baseline], fixtureRoot);
  const previousCandidateRef = "previous-candidate";
  const currentVersion = JSON.parse(
    await fs.readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  ).version;
  const currentReleaseTag = `routeledger-plugin-v${currentVersion}`;
  assertFailure(
    process.execPath,
    [checkerPath, "--previous-ref", previousCandidateRef],
    fixtureRoot,
    /without a SemVer increase; the same version may already be installed or running/
  );
  runOrThrow("git", ["tag", currentReleaseTag, previousCandidateRef], fixtureRoot);
  assertFailure(
    process.execPath,
    [checkerPath, "--previous-ref", previousCandidateRef],
    fixtureRoot,
    /without a SemVer increase; immutable tag .* already exists/
  );
  runOrThrow("git", ["tag", "--delete", currentReleaseTag], fixtureRoot);
  const linkBlob = runOrThrow("git", ["hash-object", "-w", "--stdin"], fixtureRoot, { input: "runtime/package.json\n" }).trim();
  runOrThrow("git", ["update-index", "--add", "--cacheinfo", `120000,${linkBlob},plugins/routeledger/previous-check-link`], fixtureRoot);
  runOrThrow("git", ["commit", "--quiet", "-m", "previous plugin symlink"], fixtureRoot);
  runOrThrow("git", ["branch", "symlink-previous"], fixtureRoot);
  runOrThrow("git", ["checkout", "--quiet", "--detach", baseline], fixtureRoot);
  assertFailure(process.execPath, [checkerPath, "--previous-ref", "symlink-previous"], fixtureRoot, /previous-check-link": git mode 120000 \/ type blob/);
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
