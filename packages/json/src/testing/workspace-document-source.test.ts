import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WorkspaceDocumentSource } from "../index.js";

const createTempRoot = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "routeledger-document-source-"));

const cleanupRoot = (root: string): void => {
  fs.rmSync(root, { recursive: true, force: true });
};

describe("WorkspaceDocumentSource", () => {
  it("reads workspace-relative UTF-8 files and preserves missing-file errors", async () => {
    const workspaceRoot = createTempRoot();
    const source = new WorkspaceDocumentSource({ workspaceRoot });

    try {
      fs.mkdirSync(path.join(workspaceRoot, "docs"));
      fs.writeFileSync(path.join(workspaceRoot, "docs", "entry.md"), "路线入口\n", "utf8");

      await expect(source.readUtf8("docs/entry.md")).resolves.toBe("路线入口\n");
      await expect(source.readUtf8("docs/missing.md")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      cleanupRoot(workspaceRoot);
    }
  });

  it("rejects a workspace entry symlink that resolves outside the root", async () => {
    const workspaceRoot = createTempRoot();
    const outsideRoot = createTempRoot();
    const source = new WorkspaceDocumentSource({ workspaceRoot });

    try {
      const outsideEntry = path.join(outsideRoot, "entry.md");
      fs.writeFileSync(outsideEntry, "outside\n", "utf8");
      fs.symlinkSync(outsideEntry, path.join(workspaceRoot, "README.md"));

      await expect(source.readUtf8("README.md")).rejects.toMatchObject({
        code: "ENTRY_FILE_OUTSIDE_PROJECT_ROOT",
        message: "entry file resolves outside project root via symlink: README.md"
      });
    } finally {
      cleanupRoot(workspaceRoot);
      cleanupRoot(outsideRoot);
    }
  });
});
