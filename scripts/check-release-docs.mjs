/* global console */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..");
const tagPrefix = "routeledger-plugin-v";

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

const version = latestTag.slice(tagPrefix.length);
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

const expectedText = new Map([
  ["README.md", [`已发布稳定版为 ${version}`, `${version} release note](docs/release/release-notes/${version}.md)`]],
  ["docs/release/release-policy.md", [`version ${version} is the latest published`, latestTag]],
  ["docs/release/plugin-release.md", [`latest published plugin release is \`${latestTag}\``]],
  ["docs/release/distribution-and-tags.md", [`[${version}](release-notes/${version}.md)`, `Published: Codex plugin ${version} (tag \`${latestTag}\`)`]]
]);

for (const [relativePath, snippets] of expectedText) {
  const content = files.get(relativePath);
  for (const snippet of snippets) {
    if (!content.includes(snippet)) {
      fail(`${relativePath} does not identify ${latestTag} with expected text ${JSON.stringify(snippet)}`);
    }
  }
}

await fs.access(path.join(repositoryRoot, "docs", "release", "release-notes", `${version}.md`));
console.log(`Release documentation check passed: ${latestTag}.`);
