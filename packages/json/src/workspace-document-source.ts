import fs from "node:fs/promises";
import path from "node:path";

import type { DocumentSourcePort } from "@routeledger/core";

const isPathInsideRoot = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

/**
 * Host filesystem adapter for workspace-relative entry documents.
 *
 * Resolving both the root and target physically prevents a document symlink
 * from escaping the workspace before Core can inspect its contents.
 */
export class WorkspaceDocumentSource implements DocumentSourcePort {
  private readonly workspaceRoot: string;

  constructor(options: { workspaceRoot: string }) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
  }

  async readUtf8(relativePath: string): Promise<string> {
    const realWorkspaceRoot = await fs.realpath(this.workspaceRoot);
    const resolvedPath = path.resolve(this.workspaceRoot, relativePath);
    const realResolvedPath = await fs.realpath(resolvedPath);

    if (!isPathInsideRoot(realWorkspaceRoot, realResolvedPath)) {
      const error = new Error(
        `entry file resolves outside project root via symlink: ${relativePath}`
      ) as NodeJS.ErrnoException;
      error.code = "ENTRY_FILE_OUTSIDE_PROJECT_ROOT";
      throw error;
    }

    return fs.readFile(realResolvedPath, "utf8");
  }
}
