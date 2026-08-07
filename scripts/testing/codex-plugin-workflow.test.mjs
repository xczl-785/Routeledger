import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = (await fs.readFile(path.join(repositoryRoot, ".github", "workflows", "codex-plugin.yml"), "utf8")).replaceAll(
  "\r\n",
  "\n"
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
  resolvePreviousRef({ eventName: "push", ref: "refs/tags/routeledger-plugin-v0.3.5", before, baseSha: "" }),
  null
);
assert.deepEqual(releaseArguments({ previousRef: before, ref: "refs/heads/main" }), ["--previous-ref", before]);
assert.deepEqual(releaseArguments({ previousRef: null, ref: "refs/heads/feature/provenance" }), []);
assert.deepEqual(releaseArguments({ previousRef: null, ref: "refs/tags/routeledger-plugin-v0.3.5" }), ["--require-tag-ref"]);
