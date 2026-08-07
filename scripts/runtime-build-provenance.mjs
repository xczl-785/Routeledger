import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";

export const SOURCE_TREE_STATES = ["clean", "dirty", "unavailable"];
export const PROVENANCE_GENERATED_PATHS = [
  "plugins/routeledger/runtime/mcp/src/runtime-identity.js",
  "plugins/routeledger/release.json"
];

const runGit = ({ repositoryRoot, execFile, args }) =>
  execFile("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();

const runGitRaw = ({ repositoryRoot, execFile, args }) => {
  const output = execFile("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return Buffer.isBuffer(output) ? output : Buffer.from(output, "utf8");
};

const parseRuntimeIdentityProvenance = (source) => {
  const match = /sourceTreeState:\s*("(?:clean|dirty|unavailable)"),\s*buildCommit:\s*(null|"[0-9a-fA-F]+")/.exec(source);
  if (!match) return null;
  return { sourceTreeState: JSON.parse(match[1]), buildCommit: JSON.parse(match[2]) };
};

/** Read the paired generated records; partial or disagreeing records are not reusable. */
export const readRecordedPluginBuildProvenance = ({ repositoryRoot }) => {
  try {
    const pluginRoot = path.join(repositoryRoot, "plugins", "routeledger");
    const release = JSON.parse(fs.readFileSync(path.join(pluginRoot, "release.json"), "utf8"));
    const runtimeIdentity = parseRuntimeIdentityProvenance(
      fs.readFileSync(path.join(pluginRoot, "runtime", "mcp", "src", "runtime-identity.js"), "utf8")
    );
    const releaseIdentity = release.runtimeIdentity;
    if (
      runtimeIdentity === null ||
      releaseIdentity?.sourceTreeState !== "clean" ||
      typeof releaseIdentity.buildCommit !== "string" ||
      runtimeIdentity.sourceTreeState !== releaseIdentity.sourceTreeState ||
      runtimeIdentity.buildCommit !== releaseIdentity.buildCommit
    ) {
      return null;
    }
    return runtimeIdentity;
  } catch {
    return null;
  }
};

export const isResolvableCommit = ({ repositoryRoot, commit, execFile = execFileSync }) => {
  if (typeof commit !== "string" || commit.length === 0) return false;
  try {
    runGit({ repositoryRoot, execFile, args: ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`] });
    return true;
  } catch {
    return false;
  }
};

/**
 * A generated release commit may carry the source commit that produced it,
 * only when every intervening tracked path is itself generated provenance.
 */
export const isReusableCleanBuildCommit = ({
  repositoryRoot,
  buildCommit,
  headCommit,
  execFile = execFileSync
}) => {
  if (!isResolvableCommit({ repositoryRoot, commit: buildCommit, execFile })) return false;
  try {
    const head = headCommit ?? runGit({ repositoryRoot, execFile, args: ["rev-parse", "HEAD"] });
    runGit({ repositoryRoot, execFile, args: ["merge-base", "--is-ancestor", buildCommit, head] });
    const changedPaths = runGitRaw({
      repositoryRoot,
      execFile,
      args: ["diff", "--name-only", "-z", `${buildCommit}..${head}`]
    })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return changedPaths.every((changedPath) => PROVENANCE_GENERATED_PATHS.includes(changedPath));
  } catch {
    return false;
  }
};

/**
 * Capture provenance before a build changes tracked distribution files.  Git's
 * porcelain status excludes ignored paths, so generated dist directories do
 * not turn an otherwise clean source tree into a dirty build.
 */
export const resolveRuntimeBuildProvenance = ({
  repositoryRoot,
  execFile = execFileSync,
  recordedProvenance = readRecordedPluginBuildProvenance({ repositoryRoot })
}) => {
  try {
    const status = runGit({
      repositoryRoot,
      execFile,
      args: ["status", "--porcelain=v1", "--untracked-files=normal", "--ignored=no"]
    });
    if (status.length > 0) {
      return { sourceTreeState: "dirty", buildCommit: null };
    }

    const headCommit = runGit({ repositoryRoot, execFile, args: ["rev-parse", "HEAD"] });
    if (headCommit.length === 0) {
      return { sourceTreeState: "unavailable", buildCommit: null };
    }
    const reusableBuildCommit =
      recordedProvenance?.sourceTreeState === "clean" &&
      isReusableCleanBuildCommit({
        repositoryRoot,
        buildCommit: recordedProvenance.buildCommit,
        headCommit,
        execFile
      })
        ? recordedProvenance.buildCommit
        : null;
    return { sourceTreeState: "clean", buildCommit: reusableBuildCommit ?? headCommit };
  } catch {
    return { sourceTreeState: "unavailable", buildCommit: null };
  }
};
