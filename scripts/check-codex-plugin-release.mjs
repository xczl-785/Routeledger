/* global Buffer, console, process */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectRegularFiles } from "./regular-file-tree.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const routeledgerRoot = path.resolve(scriptDir, "..");
const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: routeledgerRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
}).trim();
const pluginRoot = path.join(repositoryRoot, "plugins", "routeledger");
const pluginRelativeRoot = path.relative(repositoryRoot, pluginRoot).split(path.sep).join("/");
const manifestRelativePath = `${pluginRelativeRoot}/.codex-plugin/plugin.json`;
const marketplacePath = path.join(repositoryRoot, ".agents", "plugins", "marketplace.json");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const releaseMetadataPath = path.join(pluginRoot, "release.json");

const fail = (message) => {
  throw new Error(`Codex plugin release check failed: ${message}`);
};

export const hasValidPluginRuntimeIdentity = ({ runtimeIdentity, releaseIdentity, pluginVersion, runtimePayloadDigest }) =>
  runtimeIdentity?.runtimePackageVersion === pluginVersion &&
  runtimeIdentity?.runtimeProfile === "json-only" &&
  runtimeIdentity?.artifactKind === "plugin" &&
  runtimeIdentity?.pluginVersion === pluginVersion &&
  runtimeIdentity?.releaseTag === `routeledger-plugin-v${pluginVersion}` &&
  ["clean", "dirty", "unavailable"].includes(runtimeIdentity?.sourceTreeState) &&
  runtimeIdentity?.buildCommit === null &&
  runtimeIdentity?.artifactDigest === null &&
  runtimeIdentity?.runtimePayloadDigest === runtimePayloadDigest &&
  releaseIdentity?.runtimePackageVersion === runtimeIdentity.runtimePackageVersion &&
  releaseIdentity?.runtimeProfile === runtimeIdentity.runtimeProfile &&
  releaseIdentity?.pluginVersion === runtimeIdentity.pluginVersion &&
  releaseIdentity?.releaseTag === runtimeIdentity.releaseTag &&
  releaseIdentity?.sourceTreeState === runtimeIdentity.sourceTreeState &&
  releaseIdentity?.buildCommit === null &&
  releaseIdentity?.artifactDigest === null &&
  releaseIdentity?.runtimePayloadDigest === runtimeIdentity.runtimePayloadDigest &&
  releaseIdentity?.runtimePayloadCoverage ===
    "All regular files under plugins/routeledger/runtime, excluding mcp/src/runtime-identity.js.";

export const hasValidReleaseContentHashes = ({ releaseContent, pluginDistributionSha256, runtimeSha256 }) =>
  releaseContent?.algorithm === "sha256" &&
  /^[a-f0-9]{64}$/.test(releaseContent?.pluginDistributionSha256 ?? "") &&
  /^[a-f0-9]{64}$/.test(releaseContent?.runtimeSha256 ?? "") &&
  releaseContent?.pluginDistributionCoverage === "All regular files under plugins/routeledger, excluding release.json." &&
  releaseContent?.runtimeCoverage === "All regular files under plugins/routeledger/runtime." &&
  releaseContent.pluginDistributionSha256 === pluginDistributionSha256 &&
  releaseContent.runtimeSha256 === runtimeSha256;

const parseArguments = (argv) => {
  const options = { requireTagRef: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--require-tag-ref") {
      options.requireTagRef = true;
    } else if (argument === "--tag" || argument === "--previous-ref") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`${argument} requires a value.`);
      }
      options[argument === "--tag" ? "tag" : "previousRef"] = value;
      index += 1;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
};

const parseSemver = (version, source) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    version
  );
  if (!match) {
    fail(`${source} must be a valid semantic version; received ${JSON.stringify(version)}.`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? "" };
};

const compareSemver = (leftVersion, rightVersion) => {
  const left = parseSemver(leftVersion, "Current plugin version");
  const right = parseSemver(rightVersion, "Previous plugin version");
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] > right[key] ? 1 : -1;
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (left.prerelease === "") {
    return 1;
  }
  if (right.prerelease === "") {
    return -1;
  }
  const leftParts = left.prerelease.split(".");
  const rightParts = right.prerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    if (leftParts[index] === rightParts[index]) continue;
    const leftNumeric = /^\d+$/.test(leftParts[index]);
    const rightNumeric = /^\d+$/.test(rightParts[index]);
    if (leftNumeric && rightNumeric) return Number(leftParts[index]) > Number(rightParts[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
};

const hashEntries = (entries) => {
  const hash = createHash("sha256");
  for (const { relativePath, content } of entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"))) {
    hash.update(Buffer.from(relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(content.length), "ascii"));
    hash.update(Buffer.from([0]));
    hash.update(content);
  }
  return hash.digest("hex");
};

const hashWorkingTree = async (root, shouldInclude = () => true) => {
  let files;
  try {
    files = (await collectRegularFiles(root)).filter(({ relativePath }) => shouldInclude(relativePath));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return hashEntries(
    await Promise.all(
      files.map(async ({ absolutePath, relativePath }) => ({ relativePath, content: await fs.readFile(absolutePath) }))
    )
  );
};

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = error.stderr?.toString("utf8").trim();
    fail(`git ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
};

const parseGitTreeRecord = (ref, record) => {
  const match = /^(?<mode>[0-7]{6}) (?<type>\S+) [0-9a-f]+\t(?<filePath>[\s\S]+)$/.exec(record);
  if (!match?.groups) {
    fail(`Previous ref ${JSON.stringify(ref)} has an unreadable plugin tree entry.`);
  }
  return match.groups;
};

const previousPluginRootEntry = (ref) => {
  git(["rev-parse", "--verify", `${ref}^{commit}`]);
  try {
    const output = execFileSync("git", ["ls-tree", "-z", ref, "--", pluginRelativeRoot], {
      cwd: repositoryRoot,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"]
    })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return output.length === 1 ? parseGitTreeRecord(ref, output[0]) : null;
  } catch {
    return null;
  }
};

const hashPreviousDistribution = (ref) => {
  git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const output = execFileSync("git", ["ls-tree", "-r", "-z", ref, "--", pluginRelativeRoot], {
    cwd: repositoryRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const files = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const { mode, type, filePath } = parseGitTreeRecord(ref, record);
      const relativePath = filePath.startsWith(`${pluginRelativeRoot}/`)
        ? filePath.slice(`${pluginRelativeRoot}/`.length)
        : filePath;
      if ((mode !== "100644" && mode !== "100755") || type !== "blob") {
        fail(`Previous ref ${JSON.stringify(ref)} has unsupported plugin entry ${JSON.stringify(relativePath)}: git mode ${mode} / type ${type}.`);
      }
      return { relativePath, filePath };
    })
    .filter(({ relativePath }) => relativePath !== "release.json")
    .map(({ relativePath, filePath }) => ({
      relativePath,
      content: execFileSync("git", ["show", `${ref}:${filePath}`], { cwd: repositoryRoot, encoding: "buffer" })
    }));
  if (files.length === 0) {
    fail(`Previous ref ${JSON.stringify(ref)} has no plugin distribution files.`);
  }
  return hashEntries(files);
};

const readPreviousVersion = (ref) => {
  try {
    return JSON.parse(execFileSync("git", ["show", `${ref}:${manifestRelativePath}`], { cwd: repositoryRoot, encoding: "utf8" })).version;
  } catch {
    fail(`Previous ref ${JSON.stringify(ref)} does not contain a readable ${manifestRelativePath}.`);
  }
};

const assertMetadata = async () => {
  const [marketplace, manifest, release] = await Promise.all(
    [marketplacePath, manifestPath, releaseMetadataPath].map(async (filePath) => JSON.parse(await fs.readFile(filePath, "utf8")))
  );
  if (marketplace.name !== "routeledger-team" || marketplace.interface?.displayName !== "RouteLedger Team") {
    fail("Marketplace identity must be routeledger-team / RouteLedger Team.");
  }
  const listing = marketplace.plugins?.find((plugin) => plugin.name === manifest.name);
  if (listing?.source?.source !== "local" || listing?.source?.path !== "./plugins/routeledger") {
    fail("Marketplace RouteLedger listing must point to ./plugins/routeledger.");
  }
  parseSemver(manifest.version, "Plugin manifest version");
  if (release.schemaVersion !== 1 || release.marketplace?.name !== marketplace.name || release.marketplace?.displayName !== marketplace.interface.displayName) {
    fail("Release metadata marketplace identity does not match marketplace.json.");
  }
  if (release.plugin?.name !== manifest.name || release.plugin?.version !== manifest.version) {
    fail("Release metadata plugin name/version does not match plugin.json.");
  }
  if (
    release.attestation?.strategy !== "git-tag-external" ||
    release.attestation?.releaseTag !== `routeledger-plugin-v${manifest.version}` ||
    release.attestation?.sourceCommit !== null ||
    release.attestation?.artifactDigestField !== "content.pluginDistributionSha256"
  ) {
    fail("Release attestation metadata must point to the immutable plugin version tag and external digest proof.");
  }
  const runtimeIdentityModule = await import(
    `${pathToFileURL(path.join(pluginRoot, "runtime", "mcp", "src", "runtime-identity.js")).href}?release-check=${Date.now()}`
  );
  const runtimeIdentity = runtimeIdentityModule.resolveRuntimeIdentity("json-only");
  const runtimePayloadDigest = await hashWorkingTree(
    path.join(pluginRoot, "runtime"),
    (relativePath) => relativePath !== "mcp/src/runtime-identity.js"
  );
  if (!hasValidPluginRuntimeIdentity({
    runtimeIdentity,
    releaseIdentity: release.runtimeIdentity,
    pluginVersion: manifest.version,
    runtimePayloadDigest
  })) {
    fail("Runtime identity does not match the generated JSON-only plugin runtime and manifest.");
  }
  const [pluginDistributionSha256, runtimeSha256] = await Promise.all([
    hashWorkingTree(pluginRoot, (relativePath) => relativePath !== "release.json"),
    hashWorkingTree(path.join(pluginRoot, "runtime"))
  ]);
  if (!hasValidReleaseContentHashes({
    releaseContent: release.content,
    pluginDistributionSha256,
    runtimeSha256
  })) {
    fail("Release metadata hashes do not match the generated plugin distribution and runtime bytes.");
  }
  return { manifest, pluginDistributionSha256 };
};

const assertTagRef = (tag) => {
  let tagTarget;
  try {
    tagTarget = execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}^{}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    fail(`Release tag ${JSON.stringify(tag)} does not exist.`);
  }
  const head = git(["rev-parse", "HEAD"]);
  if (tagTarget !== head) {
    fail(`Tag ${JSON.stringify(tag)} must point to HEAD (${head}), but points to ${tagTarget}.`);
  }
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const { manifest, pluginDistributionSha256 } = await assertMetadata();
  const expectedTag = `routeledger-plugin-v${manifest.version}`;
  const tag = options.tag ?? expectedTag;
  if (tag !== expectedTag) {
    fail(`Tag must be ${JSON.stringify(expectedTag)} for plugin version ${manifest.version}; received ${JSON.stringify(tag)}.`);
  }
  if (options.previousRef) {
    const previousRootEntry = previousPluginRootEntry(options.previousRef);
    if (previousRootEntry === null) {
      console.log(
        `Codex plugin release check: ${options.previousRef} has no ${pluginRelativeRoot}; treating this as the initial plugin release.`
      );
    } else {
      if (previousRootEntry.mode !== "040000" || previousRootEntry.type !== "tree") {
        fail(`Previous ref ${JSON.stringify(options.previousRef)} has unsupported plugin entry ${JSON.stringify(pluginRelativeRoot)}: git mode ${previousRootEntry.mode} / type ${previousRootEntry.type}.`);
      }
      const previousVersion = readPreviousVersion(options.previousRef);
      const comparison = compareSemver(manifest.version, previousVersion);
      if (comparison < 0) {
        fail(`Plugin version regressed from ${previousVersion} at ${options.previousRef} to ${manifest.version}.`);
      }
      const previousDistributionSha256 = hashPreviousDistribution(options.previousRef);
      if (comparison === 0 && previousDistributionSha256 !== pluginDistributionSha256) {
        fail(`Plugin distribution bytes changed since ${options.previousRef}, but version remained ${manifest.version}.`);
      }
    }
  }
  if (options.requireTagRef) {
    assertTagRef(tag);
  }
  console.log(`Codex plugin release check passed: ${manifest.name}@${manifest.version} (${tag}).`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
