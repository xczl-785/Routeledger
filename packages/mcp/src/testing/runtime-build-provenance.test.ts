import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  PROVENANCE_GENERATED_PATHS,
  resolveRuntimeBuildProvenance
} from "../../../../scripts/runtime-build-provenance.mjs";

const createGitRepository = (): string => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-build-provenance-"));
  fs.mkdirSync(path.join(repositoryRoot, "source"));
  fs.writeFileSync(path.join(repositoryRoot, "source", "tracked.ts"), "export {};\n", "utf8");
  execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "RouteLedger Test"], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repositoryRoot, stdio: "ignore" });
  return repositoryRoot;
};

const headCommit = (repositoryRoot: string): string =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();

const commitAll = (repositoryRoot: string, message: string): void => {
  execFileSync("git", ["add", "."], { cwd: repositoryRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: repositoryRoot, stdio: "ignore" });
};

const writeGeneratedPluginProvenance = (repositoryRoot: string, content = "generated\n"): void => {
  for (const relativePath of PROVENANCE_GENERATED_PATHS) {
    const target = path.join(repositoryRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${relativePath}:${content}`, "utf8");
  }
};

describe("resolveRuntimeBuildProvenance", () => {
  it("reports the clean HEAD commit for a standalone package artifact", () => {
    const repositoryRoot = createGitRepository();
    try {
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({
        sourceTreeState: "clean",
        buildCommit: headCommit(repositoryRoot)
      });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("reports a clean content-addressed plugin build with no commit claim", () => {
    const repositoryRoot = createGitRepository();
    try {
      expect(
        resolveRuntimeBuildProvenance({
          repositoryRoot,
          ignoredChangedPaths: PROVENANCE_GENERATED_PATHS,
          includeHeadCommit: false
        })
      ).toEqual({ sourceTreeState: "clean", buildCommit: null });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("keeps a second plugin build clean when only its generated provenance changes", () => {
    const repositoryRoot = createGitRepository();
    try {
      writeGeneratedPluginProvenance(repositoryRoot, "first\n");
      commitAll(repositoryRoot, "generated plugin provenance");
      writeGeneratedPluginProvenance(repositoryRoot, "second\n");
      const options = {
        repositoryRoot,
        ignoredChangedPaths: PROVENANCE_GENERATED_PATHS,
        includeHeadCommit: false
      };
      expect(resolveRuntimeBuildProvenance(options)).toEqual({ sourceTreeState: "clean", buildCommit: null });
      expect(resolveRuntimeBuildProvenance(options)).toEqual({ sourceTreeState: "clean", buildCommit: null });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it.each(["source/new-file.ts", " leading-source.ts", "\nnewline-source.ts"])(
    "marks source changes dirty without pathname parsing exceptions: %j",
    (sourcePath) => {
      const repositoryRoot = createGitRepository();
      try {
        fs.mkdirSync(path.dirname(path.join(repositoryRoot, sourcePath)), { recursive: true });
        fs.writeFileSync(path.join(repositoryRoot, sourcePath), "export {};\n", "utf8");
        expect(
          resolveRuntimeBuildProvenance({
            repositoryRoot,
            ignoredChangedPaths: PROVENANCE_GENERATED_PATHS,
            includeHeadCommit: false
          })
        ).toEqual({ sourceTreeState: "dirty", buildCommit: null });
      } finally {
        fs.rmSync(repositoryRoot, { recursive: true, force: true });
      }
    }
  );

  it("reports unavailable for an unborn Git repository", () => {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-build-provenance-unborn-"));
    try {
      execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "ignore" });
      expect(resolveRuntimeBuildProvenance({ repositoryRoot })).toEqual({ sourceTreeState: "unavailable", buildCommit: null });
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });
});
