import fs from "node:fs";
import path from "node:path";

/**
 * Resolve existing path components through the filesystem (including symlinks,
 * Windows junctions and other reparse points). Missing tail components are kept
 * lexical only after their nearest existing parent has been physically resolved.
 */
export const resolvePhysicalPathForContainmentSync = (value: string): string | null => {
  // Do not call path.resolve()/normalize() on an already absolute path here:
  // `link/..` is resolved by the filesystem through `link`, not lexically.
  const absolute = path.isAbsolute(value) ? value : path.resolve(value);
  const parsed = path.parse(absolute);
  const segments = absolute
    .slice(parsed.root.length)
    .split(process.platform === "win32" ? /[\\/]+/u : /\/+/u);
  let current: string;

  try {
    current = fs.realpathSync.native(parsed.root);
  } catch {
    return null;
  }

  for (const segment of segments) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      current = path.dirname(current);
      continue;
    }

    const next = path.join(current, segment);
    try {
      current = fs.realpathSync.native(next);
    } catch (error) {
      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : null;
      if (errorCode !== "ENOENT" && errorCode !== "ENOTDIR") {
        return null;
      }
      // No remaining component exists, so it cannot yet be a symlink/reparse
      // point. Keep the tail relative to the already physical parent.
      current = next;
    }
  }

  return current;
};

const comparablePath = (value: string): string => {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
};

export const isPhysicalPathContainedWithinSync = (
  root: string,
  candidate: string
): boolean => {
  const physicalRoot = resolvePhysicalPathForContainmentSync(root);
  const physicalCandidate = resolvePhysicalPathForContainmentSync(candidate);

  if (physicalRoot === null || physicalCandidate === null) {
    return false;
  }

  const relativePath = path.relative(
    comparablePath(physicalRoot),
    comparablePath(physicalCandidate)
  );
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
};

export const arePhysicalPathsEqualSync = (left: string, right: string): boolean => {
  const physicalLeft = resolvePhysicalPathForContainmentSync(left);
  const physicalRight = resolvePhysicalPathForContainmentSync(right);
  return (
    physicalLeft !== null &&
    physicalRight !== null &&
    comparablePath(physicalLeft) === comparablePath(physicalRight)
  );
};
