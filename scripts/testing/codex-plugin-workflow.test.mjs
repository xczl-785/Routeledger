import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = (await fs.readFile(path.join(repositoryRoot, ".github", "workflows", "codex-plugin.yml"), "utf8")).replaceAll(
  "\r\n",
  "\n"
);
const smokeScript = await fs.readFile(
  path.join(repositoryRoot, "scripts", "smoke-codex-plugin.mjs"),
  "utf8"
);
const packageManifest = JSON.parse(
  await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")
);
const releaseCheckWrapper = await fs.readFile(
  path.join(repositoryRoot, "scripts", "check-codex-plugin-release-all.mjs"),
  "utf8"
);

assert.equal(
  packageManifest.scripts["check:codex-plugin-release"],
  "node ./scripts/check-codex-plugin-release-all.mjs"
);
assert.match(
  releaseCheckWrapper,
  /check-codex-plugin-release\.mjs"\), \.\.\.process\.argv\.slice\(2\)/,
  "Release wrapper must forward CLI arguments to the distribution/version guard."
);
assert.match(
  releaseCheckWrapper,
  /check-release-docs\.mjs"\)\]/,
  "Release wrapper must keep the documentation consistency check."
);

assert.doesNotMatch(
  smokeScript,
  /build-codex-plugin\.mjs/,
  "Codex plugin smoke must validate the committed artifact, not rebuild it first."
);
const previousRefStep = /- name: Resolve previous plugin ref\n[\s\S]*? {8}run: \|\n([\s\S]*?)(?= {6}- name: Build bundled plugin artifact)/.exec(
  workflow
);
assert.ok(previousRefStep, "Codex plugin workflow must contain the Resolve previous plugin ref step.");
assert.match(
  previousRefStep[1],
  /if \[ "\$\{\{ github\.event_name \}\}" = "pull_request" \]; then\n {12}echo "ref=\$\{\{ github\.event\.pull_request\.base\.sha \}\}"/
);
assert.match(
  previousRefStep[1],
  /elif \[ "\$\{\{ github\.ref \}\}" = "refs\/heads\/main" \] && \[ "\$\{\{ github\.event\.before \}\}" != "\$zero_ref" \]; then\n {12}echo "ref=\$\{\{ github\.event\.before \}\}"/
);

const zeroRef = "0".repeat(40);
const resolvePreviousRef = ({ eventName, ref, before, baseSha }) => {
  if (eventName === "pull_request") return baseSha;
  if (ref === "refs/heads/main" && before !== zeroRef) return before;
  return null;
};

const pluginTagPrefix = "refs/tags/routeledger-plugin-v";
const isPluginTag = (ref) => ref.startsWith(pluginTagPrefix);
const releaseArguments = ({ previousRef, ref }) => {
  const args = previousRef === null ? [] : ["--previous-ref", previousRef];
  if (isPluginTag(ref)) args.push("--require-tag-ref");
  return args;
};

assert.match(
  workflow,
  /IS_PLUGIN_TAG: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/routeledger-plugin-v'\) \}\}/
);
assert.match(
  workflow,
  /if \[ "\$IS_PLUGIN_TAG" = "true" \]; then args\+=\(--require-tag-ref\); fi/
);

const before = "a".repeat(40);
const baseSha = "b".repeat(40);
assert.equal(
  resolvePreviousRef({ eventName: "pull_request", ref: "refs/pull/10/merge", before, baseSha }),
  baseSha
);
assert.equal(
  resolvePreviousRef({ eventName: "push", ref: "refs/heads/main", before, baseSha: "" }),
  before
);
assert.equal(
  resolvePreviousRef({ eventName: "push", ref: "refs/heads/feature/provenance", before, baseSha: "" }),
  null
);
assert.equal(
  resolvePreviousRef({ eventName: "push", ref: "refs/tags/routeledger-plugin-v0.3.6", before, baseSha: "" }),
  null
);
assert.deepEqual(releaseArguments({ previousRef: before, ref: "refs/heads/main" }), ["--previous-ref", before]);
assert.deepEqual(releaseArguments({ previousRef: null, ref: "refs/heads/feature/provenance" }), []);
assert.deepEqual(releaseArguments({ previousRef: null, ref: "refs/tags/routeledger-plugin-v0.3.6" }), ["--require-tag-ref"]);

assert.match(workflow, /publish-attestation:[\s\S]*?contents: write/);
assert.match(workflow, /needs: \[plugin-contract, quality\]/);
assert.match(workflow, /actions\/download-artifact@v4/);
assert.match(workflow, /gh release create "\$RELEASE_TAG" --verify-tag/);
assert.match(workflow, /gh release download "\$RELEASE_TAG" --pattern "\$ASSET_NAME"/);
assert.match(workflow, /cmp -s "\$ATTESTATION_PATH" "\$published_path"/);
assert.match(workflow, /gh release upload "\$RELEASE_TAG" "\$ATTESTATION_PATH"/);
assert.doesNotMatch(workflow, /gh release upload[^\n]*--clobber/);
