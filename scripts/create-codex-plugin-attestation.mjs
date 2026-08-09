/* global console, process */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "routeledger");

const fail = (message) => {
  throw new Error(`Codex plugin attestation failed: ${message}`);
};

const git = (args) =>
  execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

const parseArguments = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--tag" && argument !== "--output") {
      fail(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`${argument} requires a value.`);
    }
    options[argument === "--tag" ? "tag" : "output"] = value;
    index += 1;
  }
  return options;
};

export const buildCodexPluginAttestation = ({ manifest, release, releaseTag, sourceCommit }) => {
  const expectedTag = `routeledger-plugin-v${manifest.version}`;
  const expectedRepositoryUrl = "https://github.com/xczl-785/Routeledger";
  const expectedAssetName = `${expectedTag}-attestation.json`;
  const expectedDownloadUrl = `${expectedRepositoryUrl}/releases/download/${expectedTag}/${expectedAssetName}`;
  if (releaseTag !== expectedTag) {
    fail(`release tag must be ${expectedTag}; received ${releaseTag}.`);
  }
  if (
    release.plugin?.name !== manifest.name ||
    release.plugin?.version !== manifest.version ||
    release.runtimeIdentity?.releaseTag !== releaseTag ||
    release.attestation?.releaseTag !== releaseTag ||
    release.attestation?.repositoryUrl !== expectedRepositoryUrl ||
    release.attestation?.assetName !== expectedAssetName ||
    release.attestation?.downloadUrl !== expectedDownloadUrl
  ) {
    fail("manifest, release metadata, and release tag do not identify the same plugin release.");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    fail("source commit must be a full Git SHA-1.");
  }

  return {
    schemaVersion: 1,
    subject: {
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      releaseTag,
      sourceCommit
    },
    runtimeIdentity: {
      runtimePackageVersion: release.runtimeIdentity.runtimePackageVersion,
      runtimeProfile: release.runtimeIdentity.runtimeProfile,
      provenanceStatus: release.runtimeIdentity.provenanceStatus,
      runtimePayloadDigest: release.runtimeIdentity.runtimePayloadDigest
    },
    locator: {
      repositoryUrl: release.attestation.repositoryUrl,
      releaseTag: release.attestation.releaseTag,
      assetName: release.attestation.assetName,
      downloadUrl: release.attestation.downloadUrl
    },
    artifacts: {
      algorithm: release.content.algorithm,
      pluginDistributionSha256: release.content.pluginDistributionSha256,
      runtimeSha256: release.content.runtimeSha256
    }
  };
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const workingManifest = JSON.parse(
    await fs.readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")
  );
  const releaseTag = options.tag ?? `routeledger-plugin-v${workingManifest.version}`;
  let sourceCommit;
  try {
    sourceCommit = git(["rev-parse", "--verify", `refs/tags/${releaseTag}^{commit}`]);
  } catch {
    fail(`release tag ${releaseTag} does not exist.`);
  }
  const headCommit = git(["rev-parse", "HEAD"]);
  if (sourceCommit !== headCommit) {
    fail(`release tag ${releaseTag} must point to HEAD ${headCommit}; received ${sourceCommit}.`);
  }
  let manifest;
  let release;
  try {
    manifest = JSON.parse(git(["show", `${releaseTag}:plugins/routeledger/.codex-plugin/plugin.json`]));
    release = JSON.parse(git(["show", `${releaseTag}:plugins/routeledger/release.json`]));
  } catch {
    fail(`release tag ${releaseTag} does not contain readable plugin release metadata.`);
  }

  const attestation = buildCodexPluginAttestation({
    manifest,
    release,
    releaseTag,
    sourceCommit
  });
  const rendered = `${JSON.stringify(attestation, null, 2)}\n`;
  if (options.output) {
    await fs.writeFile(path.resolve(repositoryRoot, options.output), rendered, "utf8");
  } else {
    console.log(rendered.trimEnd());
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
