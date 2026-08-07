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
