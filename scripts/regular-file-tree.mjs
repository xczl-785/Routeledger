import fs from "node:fs/promises";
import path from "node:path";

const toPortablePath = (filePath) => filePath.split(path.sep).join("/");

export const describeFileSystemEntry = (entry) => {
  if (entry.isSymbolicLink()) return "symbolic link";
  if (entry.isBlockDevice()) return "block device";
  if (entry.isCharacterDevice()) return "character device";
  if (entry.isFIFO()) return "FIFO";
  if (entry.isSocket()) return "socket";
  return "unknown entry";
};

const unsupportedEntry = (relativePath, entry) =>
  new Error(`Unsupported filesystem entry ${JSON.stringify(relativePath)}: ${describeFileSystemEntry(entry)}.`);

/**
 * Collect a directory tree only when every leaf is a regular file. This does
 * not follow symlinks, so content hashing and portable-runtime checks cannot
 * silently omit or traverse them.
 */
export const collectRegularFiles = async (root, relativeDirectory = "") => {
  const rootEntry = await fs.lstat(root);
  if (!rootEntry.isDirectory()) {
    throw unsupportedEntry(relativeDirectory || ".", rootEntry);
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRegularFiles(entryPath, relativePath)));
    } else if (entry.isFile()) {
      files.push({ absolutePath: entryPath, relativePath: toPortablePath(relativePath) });
    } else {
      throw unsupportedEntry(toPortablePath(relativePath), entry);
    }
  }
  return files;
};
