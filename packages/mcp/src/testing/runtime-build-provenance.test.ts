import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { resolveRuntimeBuildProvenance } from "../../../../scripts/runtime-build-provenance.mjs";

const createGitRepository = (): string => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-build-provenance-"));
  fs.mkdirSync(path.join(repositoryRoot, "source"));
  fs.writeFileSync(path.join(repositoryRoot, ".gitignore"), "dist/\n", "utf8");
  fs.writeFileSync(path.join(repositoryRoot, "source", "tracked.ts"), "export {};\n", "utf8");
  execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: repositoryRoot,
    stdio: "ignore"
  });
  execFileSync("git", ["config", "user.name", "RouteLedger Test"], {
    cwd: repositoryRoot,
    stdio: "ignore"
  });
  execFileSync("git", ["add", "."], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repositoryRoot, stdio: "ignore" });
  return repositoryRoot;
};

const commitAll = (repositoryRoot: string, message: string): string => {
  execFileSync("git", ["add", "."], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: repositoryRoot, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
};

const writeRecordedPluginProvenance = (repositoryRoot: string, buildCommit: string): void => {
  const pluginRoot = path.join(repositoryRoot, "plugins", "routeledger");
  fs.mkdirSync(path.join(pluginRoot, "runtime", "mcp", "src"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "runtime", "mcp", "src", "runtime-identity.js"),
    `export const resolveRuntimeIdentity = () => ({\n  sourceTreeState: "clean",\n  buildCommit: ${JSON.stringify(buildCommit)}\n});\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(pluginRoot, "release.json"),
    `${JSON.stringify({ runtimeIdentity: { sourceTreeState: "clean", buildCommit } }, null, 2)}\n`,
    "utf8"
  );
};

describe("resolveRuntimeBuildProvenance", () => {
  it("keeps HEAD only for a clean tree", () => {
    const repositoryRoot = createGitRepository();
    try {
      fs.mkdirSync(path.join(repositoryRoot, "dist"));
      fs.writeFileSync(path.join(repositoryRoot, "dist", "generated.js"), "generated\n", "utf8");
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({
        sourceTreeState: "clean",
        buildCommit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
          encoding: "utf8"
        }).trim()
      });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("marks tracked or non-ignored untracked changes dirty without reading HEAD", () => {
    const repositoryRoot = createGitRepository();
    try {
      fs.writeFileSync(path.join(repositoryRoot, "source", "new-file.ts"), "export {};\n", "utf8");
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({
        sourceTreeState: "dirty",
        buildCommit: null
      });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("marks a tracked source modification dirty", () => {
    const repositoryRoot = createGitRepository();
    try {
      fs.appendFileSync(path.join(repositoryRoot, "source", "tracked.ts"), "export const changed = true;\n");
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({
        sourceTreeState: "dirty",
        buildCommit: null
      });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("reuses a clean source commit across a generated-only release commit, keeping consecutive builds stable", () => {
    const repositoryRoot = createGitRepository();
    try {
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
      writeRecordedPluginProvenance(repositoryRoot, sourceCommit);
      commitAll(repositoryRoot, "generated provenance");

      const expected = {
        sourceTreeState: "clean",
        buildCommit: sourceCommit
      };
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual(expected);
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual(expected);
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("does not reuse recorded provenance after source changes", () => {
    const repositoryRoot = createGitRepository();
    try {
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
      writeRecordedPluginProvenance(repositoryRoot, sourceCommit);
      commitAll(repositoryRoot, "generated provenance");
      fs.writeFileSync(path.join(repositoryRoot, "source", "tracked.ts"), "export const changed = true;\n", "utf8");
      const sourceChangeCommit = commitAll(repositoryRoot, "source change");

      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({
        sourceTreeState: "clean",
        buildCommit: sourceChangeCommit
      });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it.each([" leading-source.ts", "\nnewline-source.ts"])(
    "does not reuse recorded provenance when a changed pathname begins with whitespace: %j",
    (sourcePath) => {
      const repositoryRoot = createGitRepository();
      try {
        fs.writeFileSync(path.join(repositoryRoot, sourcePath), "before\n", "utf8");
        const sourceCommit = commitAll(repositoryRoot, "source pathname fixture");
        writeRecordedPluginProvenance(repositoryRoot, sourceCommit);
        commitAll(repositoryRoot, "generated provenance");
        fs.writeFileSync(path.join(repositoryRoot, sourcePath), "after\n", "utf8");
        const sourceChangeCommit = commitAll(repositoryRoot, "source pathname change");

        expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({
          sourceTreeState: "clean",
          buildCommit: sourceChangeCommit
        });
      } finally {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
      }
    }
  );

  it("does not reuse non-ancestor or nonexistent recorded commits", () => {
    const repositoryRoot = createGitRepository();
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
      expect(
        resolveRuntimeBuildProvenance({
          repositoryRoot,
          recordedProvenance: { sourceTreeState: "clean", buildCommit: "does-not-exist" }
        })
      ).toEqual({ sourceTreeState: "clean", buildCommit: head });

      execFileSync("git", ["checkout", "--quiet", "-b", "unrelated"], { cwd: repositoryRoot });
      fs.writeFileSync(path.join(repositoryRoot, "source", "unrelated.ts"), "export {};\n", "utf8");
      const unrelatedCommit = commitAll(repositoryRoot, "unrelated commit");
      execFileSync("git", ["checkout", "--quiet", head], { cwd: repositoryRoot });
      expect(
        resolveRuntimeBuildProvenance({
          repositoryRoot,
          recordedProvenance: { sourceTreeState: "clean", buildCommit: unrelatedCommit }
        })
      ).toEqual({ sourceTreeState: "clean", buildCommit: head });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("reports unavailable for an unborn Git repository", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-build-provenance-unborn-"));
    try {
      execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "ignore" });
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({
        sourceTreeState: "unavailable",
        buildCommit: null
      });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("reports unavailable when git metadata cannot be read", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-build-provenance-unavailable-"));
    try {
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({
        sourceTreeState: "unavailable",
        buildCommit: null
      });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
