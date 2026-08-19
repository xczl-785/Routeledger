/* global console */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const tagPrefix = "routeledger-plugin-v";

const parseSemver = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
};

const isGreaterSemver = (candidate, baseline) => {
  const candidateParts = parseSemver(candidate);
  const baselineParts = parseSemver(baseline);
  if (candidateParts === null || baselineParts === null) {
    return false;
  }
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] !== baselineParts[index]) {
      return candidateParts[index] > baselineParts[index];
    }
  }
  return false;
};

const fail = (message) => {
  throw new Error(`Release documentation check failed: ${message}`);
};

const mergedTags = execFileSync(
  "git",
  ["tag", "--merged", "HEAD", "--list", `${tagPrefix}*`, "--sort=-v:refname"],
  { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
)
  .trim()
  .split("\n")
  .filter(Boolean);

const latestTag = mergedTags.find((tag) => /^routeledger-plugin-v\d+\.\d+\.\d+$/.test(tag));
if (!latestTag) {
  fail("no stable plugin tag reachable from HEAD");
}

const publishedVersion = latestTag.slice(tagPrefix.length);
const pluginManifest = JSON.parse(
  await fs.readFile(
    path.join(repositoryRoot, "plugins", "routeledger", ".codex-plugin", "plugin.json"),
    "utf8"
  )
);
const pluginVersion = pluginManifest.version;
const files = new Map(
  await Promise.all(
    [
      "README.md",
      "docs/release/release-policy.md",
      "docs/release/plugin-release.md",
      "docs/release/distribution-and-tags.md"
    ].map(async (relativePath) => [relativePath, await fs.readFile(path.join(repositoryRoot, relativePath), "utf8")])
  )
);

const expectedTextFor = (version) => {
  const tag = `${tagPrefix}${version}`;
  return new Map([
    ["README.md", [`已发布稳定版为 ${version}`, `${version} release note](docs/release/release-notes/${version}.md)`]],
    ["docs/release/release-policy.md", [`version ${version} is the latest published`, tag]],
    ["docs/release/plugin-release.md", [`latest published plugin release is \`${tag}\``]],
    ["docs/release/distribution-and-tags.md", [`[${version}](release-notes/${version}.md)`, `Published: Codex plugin ${version} (tag \`${tag}\`)`]]
  ]);
};

const candidateVersions = [publishedVersion];
if (isGreaterSemver(pluginVersion, publishedVersion)) {
  candidateVersions.push(pluginVersion);
}

const matchesVersion = (version) =>
  [...expectedTextFor(version)].every(([relativePath, snippets]) => {
    const content = files.get(relativePath);
    return snippets.every((snippet) => content.includes(snippet));
  });

const version = candidateVersions.find(matchesVersion);
if (version === undefined) {
  for (const candidateVersion of candidateVersions) {
    for (const [relativePath, snippets] of expectedTextFor(candidateVersion)) {
      const content = files.get(relativePath);
      for (const snippet of snippets) {
        if (!content.includes(snippet)) {
          fail(
            `${relativePath} does not consistently identify either ${latestTag}` +
              ` or staged ${tagPrefix}${pluginVersion}; missing ${JSON.stringify(snippet)}`
          );
        }
      }
    }
  }
  fail("release documentation does not identify one consistent release version");
}

await fs.access(path.join(repositoryRoot, "docs", "release", "release-notes", `${version}.md`));
const resolvedTag = `${tagPrefix}${version}`;
if (version !== publishedVersion) {
  const releaseNote = await fs.readFile(
    path.join(repositoryRoot, "docs", "release", "release-notes", `${version}.md`),
    "utf8"
  );
  if (!releaseNote.includes(`fixed by immutable tag \`${resolvedTag}\``)) {
    fail(`staged ${resolvedTag} release note does not declare its immutable tag`);
  }
}
console.log(
  `Release documentation check passed: ${resolvedTag}` +
    `${version === publishedVersion ? "" : " (staged before tag)"}.`
);
