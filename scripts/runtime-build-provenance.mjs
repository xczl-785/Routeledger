import { execFileSync } from "node:child_process";

export const SOURCE_TREE_STATES = ["clean", "dirty", "unavailable"];

/**
 * Capture provenance before a build changes tracked distribution files.  Git's
 * porcelain status excludes ignored paths, so generated dist directories do
 * not turn an otherwise clean source tree into a dirty build.
 */
export const resolveRuntimeBuildProvenance = ({
  repositoryRoot,
  execFile = execFileSync
}) => {
  try {
    const status = execFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=normal", "--ignored=no"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }
    ).trim();
    if (status.length > 0) {
      return { sourceTreeState: "dirty", buildCommit: null };
    }

    const buildCommit = execFile("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    if (buildCommit.length === 0) {
      return { sourceTreeState: "unavailable", buildCommit: null };
    }
    return { sourceTreeState: "clean", buildCommit };
  } catch {
    return { sourceTreeState: "unavailable", buildCommit: null };
  }
};
