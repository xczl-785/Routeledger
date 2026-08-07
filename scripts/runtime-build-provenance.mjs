import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";

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

/**
 * Return whether the working tree contains source changes. `git status -z`
 * preserves whitespace and newline pathnames; malformed records fail closed.
 */
const hasSourceChanges = ({ repositoryRoot, execFile, ignoredChangedPaths }) => {
  const records = runGitRaw({
    repositoryRoot,
    execFile,
    args: ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=no"]
  })
    .toString("utf8")
    .split("\0");
  const ignored = new Set(ignoredChangedPaths);

  for (let index = 0; index < records.length - 1; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") return true;
    const status = record.slice(0, 2);
    const pathname = record.slice(3);
    const renamedOrCopied = status[0] === "R" || status[0] === "C" || status[1] === "R" || status[1] === "C";
    const originalPathname = renamedOrCopied ? records[++index] : null;
    if ((originalPathname === null && !ignored.has(pathname)) || (originalPathname !== null && (!ignored.has(pathname) || !ignored.has(originalPathname)))) {
      return true;
    }
  }
  return false;
};

/**
 * Capture provenance before a build changes tracked distribution files.  Git's
 * porcelain status excludes ignored paths, so generated dist directories do
 * not turn an otherwise clean source tree into a dirty build.
 */
export const resolveRuntimeBuildProvenance = ({
  repositoryRoot,
  execFile = execFileSync,
  /** Generated paths excluded only when determining plugin source-tree state. */
  ignoredChangedPaths = [],
  /** Plugin provenance is content-addressed and must not claim a mutable Git commit. */
  includeHeadCommit = true
}) => {
  try {
    if (hasSourceChanges({ repositoryRoot, execFile, ignoredChangedPaths })) {
      return { sourceTreeState: "dirty", buildCommit: null };
    }

    const headCommit = runGit({ repositoryRoot, execFile, args: ["rev-parse", "HEAD"] });
    if (headCommit.length === 0) {
      return { sourceTreeState: "unavailable", buildCommit: null };
    }
    if (!includeHeadCommit) {
      return { sourceTreeState: "clean", buildCommit: null };
    }
    return { sourceTreeState: "clean", buildCommit: headCommit };
  } catch {
    return { sourceTreeState: "unavailable", buildCommit: null };
  }
};
