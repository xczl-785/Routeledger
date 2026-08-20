import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ProjectAggregateSnapshot } from "@routeledger/core";

import { ROUTELEDGER_JSON_ROOT } from "./constants.js";
import {
  decodeProjectAggregateFromJsonDocuments,
  encodeProjectAggregateToJsonDocuments,
  type RouteLedgerJsonDocument
} from "./codec.js";
import { validateRouteLedgerJsonDocuments } from "./validator.js";
import {
  auditLayoutExists,
  auditPackDocumentPath,
  buildAuditPhysicalDocuments,
  createClosedVersionAuditPack,
  readAuditPacks,
  readOperationEnvelopeDocuments,
  type AuditPhysicalDocument
} from "./audit-storage.js";

export type RouteLedgerJsonWriteErrorCode =
  | "DOCUMENT_ALREADY_EXISTS"
  | "DOCUMENT_PATH_ESCAPE"
  | "DOCUMENT_SET_INVALID"
  | "AUDIT_CONTAINER_INVALID"
  | "FILESYSTEM_RENAME_FAILED";

export type RouteLedgerJsonBusyErrorCode = "WRITE_IN_PROGRESS";

export class RouteLedgerJsonWriteError extends Error {
  readonly code: RouteLedgerJsonWriteErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: RouteLedgerJsonWriteErrorCode, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "RouteLedgerJsonWriteError";
    this.code = code;
    this.details = details;
  }
}

export interface RouteLedgerJsonWriteLockInfo {
  projectRoot: string;
  lockPath: string;
  ownerId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  retryAfterMs: number | null;
  staleAfterMs: number | null;
  expiresAt: string | null;
  pid: number | null;
}

export class RouteLedgerJsonBusyError extends Error {
  readonly code: RouteLedgerJsonBusyErrorCode;
  readonly details: RouteLedgerJsonWriteLockInfo;

  constructor(message: string, details: RouteLedgerJsonWriteLockInfo) {
    super(message);
    this.name = "RouteLedgerJsonBusyError";
    this.code = "WRITE_IN_PROGRESS";
    this.details = details;
  }
}

export interface WriteRouteLedgerJsonDocumentsOptions {
  outputRoot: string;
  documents: Iterable<RouteLedgerJsonDocument>;
  overwrite?: boolean;
}

export interface WriteRouteLedgerJsonDocumentsResult {
  outputRoot: string;
  jsonRoot: string;
  documentCount: number;
  paths: string[];
}

export interface ExportProjectAggregateToJsonDirectoryOptions {
  outputRoot: string;
  snapshot: ProjectAggregateSnapshot;
  overwrite?: boolean;
}

export interface ReplaceRouteLedgerJsonDocumentsOptions {
  outputRoot: string;
  documents: Iterable<RouteLedgerJsonDocument>;
  writeLockOwnerId?: string;
  renewLock?: () => Promise<void>;
}

export interface CompactRouteLedgerAuditOptions {
  outputRoot: string;
  writeLockOwnerId?: string;
  packClosedVersionId?: string;
}

export interface CompactRouteLedgerAuditResult {
  outputRoot: string;
  logicalDocumentCount: number;
  physicalDocumentCount: number;
  operationEnvelopeCount: number;
  auditPackCount: number;
  packedDocumentCount: number;
}

export interface RecoverRouteLedgerJsonReplacementResult {
  outputRoot: string;
  recovered: boolean;
  action: "none" | "discard_staged" | "restore_backup" | "cleanup_applied";
}

export interface RouteLedgerJsonReadOptions {
  writeLockOwnerId?: string;
}

export interface AcquireRouteLedgerJsonWriteLockOptions {
  ownerId?: string;
  retryAfterMs?: number;
  staleAfterMs?: number;
}

export interface RouteLedgerJsonWriteLockHandle extends RouteLedgerJsonWriteLockInfo {
  release: () => Promise<void>;
  renew: () => Promise<void>;
}

const compareByString = (left: string, right: string): number => left.localeCompare(right, "en");

export const ROUTELEDGER_CANONICAL_DOCUMENT_PATTERNS = [
  /^\.routeledger\/schema\/routeledger\.schema\.json$/,
  /^\.routeledger\/project\.json$/,
  /^\.routeledger\/refs\/current\.json$/,
  /^\.routeledger\/versions\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/work_items\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/todos\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/undos\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/deferred_items\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/constraints\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/assets\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/events\/\d{4}\/\d{2}\/[^/]+\.json$/,
  /^\.routeledger\/pending_operations\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/approval_artifacts\/[^/]+\/[^/]+\.json$/,
  /^\.routeledger\/ordinary_write_receipts\/[^/]+\/[^/]+\.json$/
] as const;

const ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES = [
  "project.json",
  "schema",
  "refs",
  "versions",
  "work_items",
  "todos",
  "undos",
  "deferred_items",
  "constraints",
  "assets",
  "events",
  "pending_operations",
  "approval_artifacts",
  "ordinary_write_receipts",
  "audit",
  "operations",
  "audit_packs"
] as const;

const REPLACEMENT_DIRECTORY_NAME = ".canonical-replace";
const REPLACEMENT_MANIFEST_FILENAME = "manifest.json";
const REPLACEMENT_NEXT_DIRECTORY = "next";
const REPLACEMENT_BACKUP_DIRECTORY = "backup";
const WRITE_LOCK_DIRECTORY_NAME = ".write-lock";
const WRITE_LOCK_METADATA_FILENAME = "metadata.json";
const DEFAULT_WRITE_LOCK_RETRY_AFTER_MS = 250;
const DEFAULT_WRITE_LOCK_STALE_AFTER_MS = 30_000;
const TRANSIENT_FILESYSTEM_ERROR_CODES = new Set(["EPERM", "EACCES"]);
const TRANSIENT_FILESYSTEM_RETRY_DELAYS_MS = [100, 300, 1_000, 2_000] as const;

export const isCanonicalRouteLedgerJsonPath = (documentPath: string): boolean =>
  ROUTELEDGER_CANONICAL_DOCUMENT_PATTERNS.some((pattern) => pattern.test(documentPath));

type RouteLedgerJsonReplacementState = "staged" | "backup_created" | "applied";

interface RouteLedgerJsonReplacementManifest {
  transactionId: string;
  state: RouteLedgerJsonReplacementState;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  paths: string[];
}

interface RouteLedgerJsonWriteLockMetadata {
  lockId: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  retryAfterMs: number;
  staleAfterMs: number;
  pid: number;
}

export interface RouteLedgerJsonFilesystemTestHooks {
  beforeClaimStaleLock?: (context: {
    outputRoot: string;
    lockRoot: string;
    metadata: RouteLedgerJsonWriteLockMetadata | null;
  }) => Promise<void> | void;
  beforeRename?: (context: {
    operation: string;
    sourcePath: string;
    destinationPath: string;
    attempt: number;
    entryName?: string;
  }) => Promise<void> | void;
}

let routeLedgerJsonFilesystemTestHooks: RouteLedgerJsonFilesystemTestHooks | null = null;

export const setRouteLedgerJsonFilesystemTestHooks = (
  hooks: RouteLedgerJsonFilesystemTestHooks | null
): void => {
  routeLedgerJsonFilesystemTestHooks = hooks;
};

interface PreparedDocumentWrite {
  relativePath: string;
  absolutePath: string;
  content: string;
}

const normalizeDocumentPath = (documentPath: string): string => {
  const normalizedPath = path.posix.normalize(documentPath);

  if (
    normalizedPath === "." ||
    normalizedPath.startsWith("../") ||
    path.posix.isAbsolute(normalizedPath)
  ) {
    throw new RouteLedgerJsonWriteError(
      "DOCUMENT_PATH_ESCAPE",
      `document path escapes output root: ${documentPath}`,
      {
        path: documentPath
      }
    );
  }

  return normalizedPath;
};

const resolveDocumentPath = (outputRoot: string, documentPath: string): PreparedDocumentWrite => {
  const normalizedPath = normalizeDocumentPath(documentPath);
  const absoluteOutputRoot = path.resolve(outputRoot);
  const absolutePath = path.resolve(absoluteOutputRoot, ...normalizedPath.split("/"));
  const relativeToRoot = path.relative(absoluteOutputRoot, absolutePath);

  if (
    relativeToRoot === "" ||
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new RouteLedgerJsonWriteError(
      "DOCUMENT_PATH_ESCAPE",
      `document path escapes output root: ${documentPath}`,
      {
        path: documentPath
      }
    );
  }

  return {
    relativePath: normalizedPath,
    absolutePath,
    content: ""
  };
};

const prepareDocumentWrites = (
  outputRoot: string,
  documents: Iterable<RouteLedgerJsonDocument>
): PreparedDocumentWrite[] =>
  [...documents].map((document) => {
    const resolved = resolveDocumentPath(outputRoot, document.path);
    return {
      ...resolved,
      content: document.content
    };
  });

const getAbsoluteJsonRoot = (outputRoot: string): string =>
  path.join(path.resolve(outputRoot), ROUTELEDGER_JSON_ROOT);

const getReplacementRoot = (outputRoot: string): string =>
  path.join(getAbsoluteJsonRoot(outputRoot), REPLACEMENT_DIRECTORY_NAME);

const getReplacementManifestPath = (outputRoot: string): string =>
  path.join(getReplacementRoot(outputRoot), REPLACEMENT_MANIFEST_FILENAME);

const getReplacementNextRoot = (outputRoot: string): string =>
  path.join(getReplacementRoot(outputRoot), REPLACEMENT_NEXT_DIRECTORY);

const getReplacementBackupRoot = (outputRoot: string): string =>
  path.join(getReplacementRoot(outputRoot), REPLACEMENT_BACKUP_DIRECTORY);

const getWriteLockRoot = (outputRoot: string): string =>
  path.join(getAbsoluteJsonRoot(outputRoot), WRITE_LOCK_DIRECTORY_NAME);

const getWriteLockMetadataPath = (outputRoot: string): string =>
  path.join(getWriteLockRoot(outputRoot), WRITE_LOCK_METADATA_FILENAME);

const getWriteLockMarkerPath = (outputRoot: string, lockId: string): string =>
  path.join(getWriteLockRoot(outputRoot), `.lock-owner-${lockId}.marker`);

const toReplacementRelativePath = (documentPath: string): string => {
  const normalizedPath = normalizeDocumentPath(documentPath);

  if (!normalizedPath.startsWith(`${ROUTELEDGER_JSON_ROOT}/`)) {
    throw new RouteLedgerJsonWriteError(
      "DOCUMENT_PATH_ESCAPE",
      `document path must stay inside ${ROUTELEDGER_JSON_ROOT}: ${documentPath}`,
      {
        path: documentPath
      }
    );
  }

  return normalizedPath.slice(`${ROUTELEDGER_JSON_ROOT}/`.length);
};

const readCanonicalDocumentsFromJsonRoot = async (
  absoluteJsonRoot: string
): Promise<RouteLedgerJsonDocument[]> => {
  const visit = async (directory: string, relativeDirectory: string): Promise<RouteLedgerJsonDocument[]> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const documents: RouteLedgerJsonDocument[] = [];

    for (const entry of entries) {
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;

      if (entry.isDirectory()) {
        const topLevelDirectory = relativePath.split("/")[0];

        if (topLevelDirectory === "db" || topLevelDirectory === "views") {
          continue;
        }

        documents.push(...(await visit(path.join(directory, entry.name), relativePath)));
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const documentPath = `${ROUTELEDGER_JSON_ROOT}/${relativePath}`;

      if (!isCanonicalRouteLedgerJsonPath(documentPath)) {
        continue;
      }

      documents.push({
        path: documentPath,
        content: await fs.readFile(path.join(directory, entry.name), "utf8")
      });
    }

    return documents;
  };

  try {
    const packs = await readAuditPacks(
      absoluteJsonRoot,
      (message, details) => new RouteLedgerJsonWriteError(
        "AUDIT_CONTAINER_INVALID",
        message,
        details
      )
    );
    const documents = [
      ...(await visit(absoluteJsonRoot, "")),
      ...(await readOperationEnvelopeDocuments(
        absoluteJsonRoot,
        (message, details) => new RouteLedgerJsonWriteError(
          "AUDIT_CONTAINER_INVALID",
          message,
          details
        )
      )),
      ...packs.flatMap((pack) => pack.logicalDocuments)
    ];
    const paths = new Set<string>();
    for (const document of documents) {
      if (paths.has(document.path)) {
        throw new RouteLedgerJsonWriteError(
          "AUDIT_CONTAINER_INVALID",
          `audit container duplicates logical document path: ${document.path}`,
          { path: document.path }
        );
      }
      paths.add(document.path);
    }
    return documents.sort((left, right) => compareByString(left.path, right.path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const writeReplacementManifest = async (
  outputRoot: string,
  manifest: RouteLedgerJsonReplacementManifest
): Promise<void> => {
  const manifestPath = getReplacementManifestPath(outputRoot);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = `${manifestPath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await fs.rename(tempPath, manifestPath);
};

const readReplacementManifest = async (
  outputRoot: string
): Promise<RouteLedgerJsonReplacementManifest | null> => {
  try {
    const manifestContent = await fs.readFile(getReplacementManifestPath(outputRoot), "utf8");
    return JSON.parse(manifestContent) as RouteLedgerJsonReplacementManifest;
  } catch (error) {
    if (
      (error instanceof Error && "code" in error && error.code === "ENOENT") ||
      error instanceof SyntaxError
    ) {
      return null;
    }

    throw error;
  }
};

const writeWriteLockMetadata = async (
  outputRoot: string,
  metadata: RouteLedgerJsonWriteLockMetadata
): Promise<void> => {
  const metadataPath = getWriteLockMetadataPath(outputRoot);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const tempPath = `${metadataPath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tempPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  await fs.rename(tempPath, metadataPath);
};

const readWriteLockMetadata = async (
  outputRoot: string
): Promise<RouteLedgerJsonWriteLockMetadata | null> => {
  try {
    const content = await fs.readFile(getWriteLockMetadataPath(outputRoot), "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;

    if (
      typeof parsed.lockId === "string" &&
      typeof parsed.ownerId === "string" &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.updatedAt === "string" &&
      typeof parsed.retryAfterMs === "number" &&
      typeof parsed.staleAfterMs === "number" &&
      typeof parsed.pid === "number"
    ) {
      return {
        lockId: parsed.lockId,
        ownerId: parsed.ownerId,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        retryAfterMs: parsed.retryAfterMs,
        staleAfterMs: parsed.staleAfterMs,
        pid: parsed.pid
      };
    }

    return null;
  } catch (error) {
    if (
      (error instanceof Error && "code" in error && error.code === "ENOENT") ||
      error instanceof SyntaxError
    ) {
      return null;
    }

    throw error;
  }
};

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

const getErrorCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;

const isTransientFilesystemError = (error: unknown): boolean => {
  const code = getErrorCode(error);
  return code !== null && TRANSIENT_FILESYSTEM_ERROR_CODES.has(code);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const renameWithTransientRetry = async ({
  operation,
  sourcePath,
  destinationPath,
  entryName
}: {
  operation: string;
  sourcePath: string;
  destinationPath: string;
  entryName?: string;
}): Promise<void> => {
  const maxAttempts = TRANSIENT_FILESYSTEM_RETRY_DELAYS_MS.length + 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await routeLedgerJsonFilesystemTestHooks?.beforeRename?.({
        operation,
        sourcePath,
        destinationPath,
        attempt,
        entryName
      });
      await fs.rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      lastError = error;

      if (!isTransientFilesystemError(error) || attempt === maxAttempts) {
        throw error;
      }

      await sleep(TRANSIENT_FILESYSTEM_RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  throw lastError;
};

const createRenameFailureError = ({
  operation,
  sourcePath,
  destinationPath,
  entryName,
  error
}: {
  operation: string;
  sourcePath: string;
  destinationPath: string;
  entryName?: string;
  error: unknown;
}): RouteLedgerJsonWriteError =>
  new RouteLedgerJsonWriteError(
    "FILESYSTEM_RENAME_FAILED",
    `failed to rename RouteLedger canonical JSON entry during ${operation}`,
    {
      operation,
      sourcePath,
      destinationPath,
      entryName: entryName ?? null,
      errorCode: getErrorCode(error),
      causeMessage: error instanceof Error ? error.message : String(error)
    }
  );

const parseIsoTimestamp = (value: string | null | undefined): number | null => {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const computeWriteLockExpiry = (
  metadata: RouteLedgerJsonWriteLockMetadata | null,
  fallbackUpdatedAtMs?: number | null,
  fallbackStaleAfterMs = DEFAULT_WRITE_LOCK_STALE_AFTER_MS
): { expiresAt: string | null; isStale: boolean } => {
  if (metadata === null) {
    if (fallbackUpdatedAtMs === null || fallbackUpdatedAtMs === undefined) {
      return {
        expiresAt: null,
        isStale: false
      };
    }

    const expiresAtMs = fallbackUpdatedAtMs + fallbackStaleAfterMs;
    return {
      expiresAt: new Date(expiresAtMs).toISOString(),
      isStale: Date.now() >= expiresAtMs
    };
  }

  const updatedAtMs = parseIsoTimestamp(metadata.updatedAt);

  if (updatedAtMs === null) {
    return {
      expiresAt: null,
      isStale: false
    };
  }

  const expiresAtMs = updatedAtMs + metadata.staleAfterMs;

  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    isStale: Date.now() >= expiresAtMs
  };
};

const toWriteLockInfo = (
  outputRoot: string,
  metadata: RouteLedgerJsonWriteLockMetadata | null,
  fallbackUpdatedAtMs?: number | null
): RouteLedgerJsonWriteLockInfo => {
  const expiry = computeWriteLockExpiry(metadata, fallbackUpdatedAtMs);

  return {
    projectRoot: path.resolve(outputRoot),
    lockPath: getWriteLockRoot(outputRoot),
    ownerId: metadata?.ownerId ?? null,
    createdAt: metadata?.createdAt ?? null,
    updatedAt: metadata?.updatedAt ?? null,
    retryAfterMs: metadata?.retryAfterMs ?? null,
    staleAfterMs: metadata?.staleAfterMs ?? null,
    expiresAt: expiry.expiresAt,
    pid: metadata?.pid ?? null
  };
};

const writeLockMetadataMatches = (
  left: RouteLedgerJsonWriteLockMetadata | null,
  right: RouteLedgerJsonWriteLockMetadata | null
): boolean =>
  left?.lockId === right?.lockId &&
  left?.ownerId === right?.ownerId &&
  left?.createdAt === right?.createdAt &&
  left?.updatedAt === right?.updatedAt &&
  left?.retryAfterMs === right?.retryAfterMs &&
  left?.staleAfterMs === right?.staleAfterMs &&
  left?.pid === right?.pid;

const getWriteLockDirectoryMtimeMs = async (outputRoot: string): Promise<number | null> => {
  try {
    const stat = await fs.stat(getWriteLockRoot(outputRoot));
    return stat.mtimeMs;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const listExistingCanonicalEntries = async (rootPath: string): Promise<string[]> => {
  const existingEntries: string[] = [];

  for (const entryName of ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES) {
    if (await pathExists(path.join(rootPath, entryName))) {
      existingEntries.push(entryName);
    }
  }

  return existingEntries;
};

const clearReplacementDirectory = async (outputRoot: string): Promise<void> => {
  await fs.rm(getReplacementRoot(outputRoot), { recursive: true, force: true });
};

const moveExistingCanonicalEntriesToBackup = async (outputRoot: string): Promise<void> => {
  const absoluteJsonRoot = getAbsoluteJsonRoot(outputRoot);
  const backupRoot = getReplacementBackupRoot(outputRoot);
  await fs.mkdir(backupRoot, { recursive: true });

  for (const entryName of ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES) {
    const sourcePath = path.join(absoluteJsonRoot, entryName);
    const destinationPath = path.join(backupRoot, entryName);

    try {
      await renameWithTransientRetry({
        operation: "backup_existing_canonical_entry",
        sourcePath,
        destinationPath,
        entryName
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw createRenameFailureError({
        operation: "backup_existing_canonical_entry",
        sourcePath,
        destinationPath,
        entryName,
        error
      });
    }
  }
};

const moveReplacementEntriesIntoCanonicalRoot = async (outputRoot: string): Promise<void> => {
  const absoluteJsonRoot = getAbsoluteJsonRoot(outputRoot);
  const nextRoot = getReplacementNextRoot(outputRoot);

  for (const entryName of ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES) {
    const sourcePath = path.join(nextRoot, entryName);
    const destinationPath = path.join(absoluteJsonRoot, entryName);

    try {
      await renameWithTransientRetry({
        operation: "apply_replacement_canonical_entry",
        sourcePath,
        destinationPath,
        entryName
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw createRenameFailureError({
        operation: "apply_replacement_canonical_entry",
        sourcePath,
        destinationPath,
        entryName,
        error
      });
    }
  }
};

const removeSelectedCanonicalEntriesFromJsonRoot = async (
  outputRoot: string,
  entryNames: readonly string[]
): Promise<void> => {
  const absoluteJsonRoot = getAbsoluteJsonRoot(outputRoot);

  for (const entryName of entryNames) {
    await fs.rm(path.join(absoluteJsonRoot, entryName), {
      recursive: true,
      force: true
    });
  }
};

const restoreCanonicalEntriesFromBackup = async (
  outputRoot: string,
  entryNames: readonly string[]
): Promise<void> => {
  const absoluteJsonRoot = getAbsoluteJsonRoot(outputRoot);
  const backupRoot = getReplacementBackupRoot(outputRoot);

  await removeSelectedCanonicalEntriesFromJsonRoot(outputRoot, entryNames);
  await fs.mkdir(absoluteJsonRoot, { recursive: true });

  for (const entryName of entryNames) {
    const sourcePath = path.join(backupRoot, entryName);
    const destinationPath = path.join(absoluteJsonRoot, entryName);

    try {
      await fs.cp(sourcePath, destinationPath, {
        recursive: true,
        force: true
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }
};

const validatePreparedDocumentSet = (documents: RouteLedgerJsonDocument[]): void => {
  const validation = validateRouteLedgerJsonDocuments(documents);

  if (!validation.valid) {
    throw new RouteLedgerJsonWriteError(
      "DOCUMENT_SET_INVALID",
      "canonical JSON document set is invalid",
      {
        issues: validation.issues
      }
    );
  }
};

const tryReadValidCanonicalDocuments = async (
  outputRoot: string
): Promise<RouteLedgerJsonDocument[] | null> => {
  const documents = await readCanonicalDocumentsFromJsonRoot(getAbsoluteJsonRoot(outputRoot));

  try {
    validatePreparedDocumentSet(documents);
    return documents;
  } catch (error) {
    if (error instanceof RouteLedgerJsonWriteError && error.code === "DOCUMENT_SET_INVALID") {
      return null;
    }

    throw error;
  }
};

const stageReplacementDocumentSet = async (
  outputRoot: string,
  physicalDocuments: AuditPhysicalDocument[],
  expectedLogicalDocuments: RouteLedgerJsonDocument[]
): Promise<void> => {
  const nextRoot = getReplacementNextRoot(outputRoot);

  await fs.rm(nextRoot, { recursive: true, force: true });

  for (const document of physicalDocuments) {
    const replacementRelativePath = toReplacementRelativePath(document.path);
    const absolutePath = path.join(nextRoot, ...replacementRelativePath.split("/"));
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, document.content, "utf8");
  }

  const stagedDocuments = await readCanonicalDocumentsFromJsonRoot(nextRoot);
  validatePreparedDocumentSet(stagedDocuments);

  if (stagedDocuments.length !== expectedLogicalDocuments.length) {
    throw new RouteLedgerJsonWriteError(
      "DOCUMENT_SET_INVALID",
      "staged canonical JSON document set is incomplete",
      {
        expectedDocumentCount: expectedLogicalDocuments.length,
        stagedDocumentCount: stagedDocuments.length
      }
    );
  }
};

export const getRouteLedgerJsonWriteLockInfo = async (
  outputRoot: string
): Promise<RouteLedgerJsonWriteLockInfo | null> => {
  const absoluteOutputRoot = path.resolve(outputRoot);
  const lockRoot = getWriteLockRoot(absoluteOutputRoot);

  if (!(await pathExists(lockRoot))) {
    return null;
  }

  const metadata = await readWriteLockMetadata(absoluteOutputRoot);
  const directoryMtimeMs = await getWriteLockDirectoryMtimeMs(absoluteOutputRoot);
  return toWriteLockInfo(absoluteOutputRoot, metadata, directoryMtimeMs);
};

const tryRecoverStaleRouteLedgerWriteLock = async (outputRoot: string): Promise<boolean> => {
  const absoluteOutputRoot = path.resolve(outputRoot);
  const lockRoot = getWriteLockRoot(absoluteOutputRoot);

  if (!(await pathExists(lockRoot))) {
    return false;
  }

  const observedMetadata = await readWriteLockMetadata(absoluteOutputRoot);
  const directoryMtimeMs = await getWriteLockDirectoryMtimeMs(absoluteOutputRoot);
  const observedExpiry = computeWriteLockExpiry(observedMetadata, directoryMtimeMs);

  if (!observedExpiry.isStale) {
    return false;
  }

  await routeLedgerJsonFilesystemTestHooks?.beforeClaimStaleLock?.({
    outputRoot: absoluteOutputRoot,
    lockRoot,
    metadata: observedMetadata
  });

  if (observedMetadata !== null) {
    const currentMetadata = await readWriteLockMetadata(absoluteOutputRoot);

    if (!writeLockMetadataMatches(observedMetadata, currentMetadata)) {
      return false;
    }

    const ownerMarkerPath = getWriteLockMarkerPath(absoluteOutputRoot, observedMetadata.lockId);
    const claimedMarkerPath = path.join(
      lockRoot,
      `.reap-claim-${observedMetadata.lockId}-${process.pid}-${randomUUID()}`
    );

    try {
      await fs.rename(ownerMarkerPath, claimedMarkerPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }

      throw error;
    }

    const verifiedMetadata = await readWriteLockMetadata(absoluteOutputRoot);

    if (!writeLockMetadataMatches(observedMetadata, verifiedMetadata)) {
      try {
        await fs.rename(claimedMarkerPath, ownerMarkerPath);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
      return false;
    }

    await fs.rm(lockRoot, { recursive: true, force: true });
    return true;
  }

  const reaperClaimPath = path.join(lockRoot, `.reap-claim-corrupt-${process.pid}-${randomUUID()}`);

  try {
    await fs.writeFile(reaperClaimPath, "stale-corrupt-lock\n", {
      flag: "wx"
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }

  const currentMetadata = await readWriteLockMetadata(absoluteOutputRoot);

  if (currentMetadata !== null) {
    await fs.rm(reaperClaimPath, { force: true });
    return false;
  }

  await fs.rm(lockRoot, { recursive: true, force: true });
  return true;
};

export const getActiveRouteLedgerJsonWriteLockInfo = async (
  outputRoot: string
): Promise<RouteLedgerJsonWriteLockInfo | null> => {
  const absoluteOutputRoot = path.resolve(outputRoot);

  if (await tryRecoverStaleRouteLedgerWriteLock(absoluteOutputRoot)) {
    return null;
  }

  return getRouteLedgerJsonWriteLockInfo(absoluteOutputRoot);
};

const assertNoActiveRouteLedgerWriteLock = async (
  outputRoot: string,
  options: RouteLedgerJsonReadOptions = {}
): Promise<void> => {
  const lockInfo = await getActiveRouteLedgerJsonWriteLockInfo(outputRoot);

  if (lockInfo === null) {
    return;
  }

  if (
    options.writeLockOwnerId !== undefined &&
    lockInfo.ownerId !== null &&
    lockInfo.ownerId === options.writeLockOwnerId
  ) {
    return;
  }

  throw new RouteLedgerJsonBusyError(
    "RouteLedger canonical JSON write is already in progress for this projectRoot",
    lockInfo
  );
};

export const acquireRouteLedgerJsonWriteLock = async (
  outputRoot: string,
  options: AcquireRouteLedgerJsonWriteLockOptions = {}
): Promise<RouteLedgerJsonWriteLockHandle> => {
  const absoluteOutputRoot = path.resolve(outputRoot);
  const lockRoot = getWriteLockRoot(absoluteOutputRoot);
  const lockId = randomUUID();
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_WRITE_LOCK_RETRY_AFTER_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_WRITE_LOCK_STALE_AFTER_MS;
  const ownerId = options.ownerId ?? randomUUID();
  const now = new Date().toISOString();
  const metadata: RouteLedgerJsonWriteLockMetadata = {
    lockId,
    ownerId,
    createdAt: now,
    updatedAt: now,
    retryAfterMs,
    staleAfterMs,
    pid: process.pid
  };
  let acquired = false;

  while (!acquired) {
    try {
      await fs.mkdir(path.dirname(lockRoot), { recursive: true });
      await fs.mkdir(lockRoot, { recursive: false });
      acquired = true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        if (await tryRecoverStaleRouteLedgerWriteLock(absoluteOutputRoot)) {
          continue;
        }

        const lockInfo =
          (await getRouteLedgerJsonWriteLockInfo(absoluteOutputRoot)) ??
          toWriteLockInfo(absoluteOutputRoot, null);
        throw new RouteLedgerJsonBusyError(
          "RouteLedger canonical JSON write is already in progress for this projectRoot",
          lockInfo
        );
      }

      throw error;
    }
  }

  try {
    await fs.writeFile(getWriteLockMarkerPath(absoluteOutputRoot, lockId), `${ownerId}\n`, {
      flag: "wx"
    });
    await writeWriteLockMetadata(absoluteOutputRoot, metadata);
  } catch (error) {
    await fs.rm(lockRoot, { recursive: true, force: true });
    throw error;
  }

  let released = false;

  const assertLockStillOwned = async (): Promise<void> => {
    const currentMetadata = await readWriteLockMetadata(absoluteOutputRoot);

    if (currentMetadata !== null && currentMetadata.ownerId !== ownerId) {
      throw new RouteLedgerJsonBusyError(
        "RouteLedger canonical JSON write lock was reclaimed by another owner",
        toWriteLockInfo(absoluteOutputRoot, currentMetadata)
      );
    }
  };

  return {
    ...toWriteLockInfo(absoluteOutputRoot, metadata),
    renew: async () => {
      if (released) {
        return;
      }

      await assertLockStillOwned();
      const refreshed: RouteLedgerJsonWriteLockMetadata = {
        ...metadata,
        updatedAt: new Date().toISOString()
      };
      await writeWriteLockMetadata(absoluteOutputRoot, refreshed);
      metadata.updatedAt = refreshed.updatedAt;
    },
    release: async () => {
      if (released) {
        return;
      }

      released = true;

      const currentMetadata = await readWriteLockMetadata(absoluteOutputRoot);

      if (currentMetadata !== null && currentMetadata.ownerId !== ownerId) {
        return;
      }

      await fs.rm(lockRoot, { recursive: true, force: true });
    }
  };
};

export const recoverRouteLedgerJsonReplacement = async (
  outputRoot: string,
  options: RouteLedgerJsonReadOptions = {}
): Promise<RecoverRouteLedgerJsonReplacementResult> => {
  const absoluteOutputRoot = path.resolve(outputRoot);
  const replacementRoot = getReplacementRoot(absoluteOutputRoot);
  const backupRoot = getReplacementBackupRoot(absoluteOutputRoot);

  await assertNoActiveRouteLedgerWriteLock(absoluteOutputRoot, options);

  try {
    await fs.access(replacementRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        outputRoot: absoluteOutputRoot,
        recovered: false,
        action: "none"
      };
    }

    throw error;
  }

  const manifest = await readReplacementManifest(absoluteOutputRoot);
  const backupEntries = await listExistingCanonicalEntries(backupRoot);
  const hasRecoverableBackup = backupEntries.length > 0;
  const currentCanonicalDocuments = await tryReadValidCanonicalDocuments(absoluteOutputRoot);
  const hasValidCurrentCanonical = currentCanonicalDocuments !== null;

  if (manifest === null) {
    if (hasValidCurrentCanonical) {
      await clearReplacementDirectory(absoluteOutputRoot);
      return {
        outputRoot: absoluteOutputRoot,
        recovered: true,
        action: "cleanup_applied"
      };
    }

    if (hasRecoverableBackup) {
      await restoreCanonicalEntriesFromBackup(absoluteOutputRoot, backupEntries);
      await clearReplacementDirectory(absoluteOutputRoot);
      return {
        outputRoot: absoluteOutputRoot,
        recovered: true,
        action: "restore_backup"
      };
    }

    await clearReplacementDirectory(absoluteOutputRoot);
    return {
      outputRoot: absoluteOutputRoot,
      recovered: true,
      action: "discard_staged"
    };
  }

  if (manifest.state === "applied") {
    if (hasValidCurrentCanonical) {
      await clearReplacementDirectory(absoluteOutputRoot);
      return {
        outputRoot: absoluteOutputRoot,
        recovered: true,
        action: "cleanup_applied"
      };
    }

    if (hasRecoverableBackup) {
      await restoreCanonicalEntriesFromBackup(absoluteOutputRoot, backupEntries);
      await clearReplacementDirectory(absoluteOutputRoot);
      return {
        outputRoot: absoluteOutputRoot,
        recovered: true,
        action: "restore_backup"
      };
    }

    await clearReplacementDirectory(absoluteOutputRoot);
    return {
      outputRoot: absoluteOutputRoot,
      recovered: true,
      action: "cleanup_applied"
    };
  }

  if (manifest.state === "backup_created") {
    await restoreCanonicalEntriesFromBackup(
      absoluteOutputRoot,
      ROUTELEDGER_CANONICAL_TOP_LEVEL_ENTRIES
    );
    await clearReplacementDirectory(absoluteOutputRoot);
    return {
      outputRoot: absoluteOutputRoot,
      recovered: true,
      action: "restore_backup"
    };
  }

  if (hasRecoverableBackup) {
    await restoreCanonicalEntriesFromBackup(absoluteOutputRoot, backupEntries);
    await clearReplacementDirectory(absoluteOutputRoot);
    return {
      outputRoot: absoluteOutputRoot,
      recovered: true,
      action: "restore_backup"
    };
  }

  await clearReplacementDirectory(absoluteOutputRoot);
  return {
    outputRoot: absoluteOutputRoot,
    recovered: true,
    action: "discard_staged"
  };
};

export const writeRouteLedgerJsonDocuments = async ({
  outputRoot,
  documents,
  overwrite = false
}: WriteRouteLedgerJsonDocumentsOptions): Promise<WriteRouteLedgerJsonDocumentsResult> => {
  const preparedDocuments = prepareDocumentWrites(outputRoot, documents);

  if (!overwrite) {
    for (const document of preparedDocuments) {
      try {
        await fs.access(document.absolutePath);
        throw new RouteLedgerJsonWriteError(
          "DOCUMENT_ALREADY_EXISTS",
          `document already exists: ${document.relativePath}`,
          {
            path: document.relativePath
          }
        );
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  for (const document of preparedDocuments) {
    await fs.mkdir(path.dirname(document.absolutePath), { recursive: true });
    await fs.writeFile(document.absolutePath, document.content, "utf8");
  }

  const absoluteOutputRoot = path.resolve(outputRoot);

  return {
    outputRoot: absoluteOutputRoot,
    jsonRoot: path.join(absoluteOutputRoot, ROUTELEDGER_JSON_ROOT),
    documentCount: preparedDocuments.length,
    paths: preparedDocuments.map((document) => document.relativePath)
  };
};

const applyRouteLedgerJsonReplacement = async (
  absoluteOutputRoot: string,
  normalizedDocuments: RouteLedgerJsonDocument[],
  physicalDocuments: AuditPhysicalDocument[],
  writeLockOwnerId?: string,
  renewLock?: () => Promise<void>
): Promise<WriteRouteLedgerJsonDocumentsResult> => {
  await recoverRouteLedgerJsonReplacement(absoluteOutputRoot, {
    writeLockOwnerId
  });
  await clearReplacementDirectory(absoluteOutputRoot);

  const now = new Date().toISOString();
  const manifestBase: RouteLedgerJsonReplacementManifest = {
    transactionId: randomUUID(),
    state: "staged",
    createdAt: now,
    updatedAt: now,
    documentCount: normalizedDocuments.length,
    paths: normalizedDocuments.map((document) => document.path)
  };

  await writeReplacementManifest(absoluteOutputRoot, manifestBase);
  await stageReplacementDocumentSet(absoluteOutputRoot, physicalDocuments, normalizedDocuments);
  await renewLock?.();
  await moveExistingCanonicalEntriesToBackup(absoluteOutputRoot);
  await writeReplacementManifest(absoluteOutputRoot, {
    ...manifestBase,
    state: "backup_created",
    updatedAt: new Date().toISOString()
  });
  await renewLock?.();
  await moveReplacementEntriesIntoCanonicalRoot(absoluteOutputRoot);
  await writeReplacementManifest(absoluteOutputRoot, {
    ...manifestBase,
    state: "applied",
    updatedAt: new Date().toISOString()
  });
  await renewLock?.();
  await clearReplacementDirectory(absoluteOutputRoot);

  return {
    outputRoot: absoluteOutputRoot,
    jsonRoot: path.join(absoluteOutputRoot, ROUTELEDGER_JSON_ROOT),
    documentCount: normalizedDocuments.length,
    paths: normalizedDocuments.map((document) => document.path)
  };
};

export const replaceRouteLedgerJsonDocuments = async ({
  outputRoot,
  documents,
  writeLockOwnerId,
  renewLock
}: ReplaceRouteLedgerJsonDocumentsOptions): Promise<WriteRouteLedgerJsonDocumentsResult> => {
  const absoluteOutputRoot = path.resolve(outputRoot);
  const normalizedDocuments = [...documents].map((document) => ({
    path: normalizeDocumentPath(document.path),
    content: document.content
  }));
  validatePreparedDocumentSet(normalizedDocuments);
  const usesCompactAuditLayout = await auditLayoutExists(getAbsoluteJsonRoot(absoluteOutputRoot));
  let physicalDocuments: AuditPhysicalDocument[] = normalizedDocuments;
  if (usesCompactAuditLayout) {
    const preservedPacks = await readAuditPacks(
      getAbsoluteJsonRoot(absoluteOutputRoot),
      (message, details) => new RouteLedgerJsonWriteError(
        "AUDIT_CONTAINER_INVALID",
        message,
        details
      )
    );
    try {
      physicalDocuments = buildAuditPhysicalDocuments(normalizedDocuments, preservedPacks).documents;
    } catch (error) {
      throw new RouteLedgerJsonWriteError(
        "AUDIT_CONTAINER_INVALID",
        error instanceof Error ? error.message : "packed audit document is immutable",
        {}
      );
    }
  }
  return applyRouteLedgerJsonReplacement(
    absoluteOutputRoot,
    normalizedDocuments,
    physicalDocuments,
    writeLockOwnerId,
    renewLock
  );
};

export const compactRouteLedgerAudit = async ({
  outputRoot,
  writeLockOwnerId,
  packClosedVersionId
}: CompactRouteLedgerAuditOptions): Promise<CompactRouteLedgerAuditResult> => {
  const absoluteOutputRoot = path.resolve(outputRoot);
  const logicalDocuments = await readRouteLedgerJsonDocuments(absoluteOutputRoot, {
    writeLockOwnerId
  });
  validatePreparedDocumentSet(logicalDocuments);
  const existingPacks = await readAuditPacks(
    getAbsoluteJsonRoot(absoluteOutputRoot),
    (message, details) => new RouteLedgerJsonWriteError(
      "AUDIT_CONTAINER_INVALID",
      message,
      details
    )
  );
  const packs = [...existingPacks];
  if (packClosedVersionId !== undefined) {
    if (existingPacks.some((pack) =>
      pack.physicalDocument.path === auditPackDocumentPath(packClosedVersionId)
    )) {
      throw new RouteLedgerJsonWriteError(
        "AUDIT_CONTAINER_INVALID",
        `audit pack already exists for Version ${packClosedVersionId}`,
        { versionId: packClosedVersionId }
      );
    }
    const snapshot = decodeProjectAggregateFromJsonDocuments(logicalDocuments);
    const version = snapshot.versions.find((candidate) => candidate.id === packClosedVersionId);
    if (version === undefined || version.state !== "close" || version.closedAt === null) {
      throw new RouteLedgerJsonWriteError(
        "AUDIT_CONTAINER_INVALID",
        `Version must be closed before its audit records can be packed: ${packClosedVersionId}`,
        { versionId: packClosedVersionId }
      );
    }
    const alreadyPackedPaths = new Set(
      existingPacks.flatMap((pack) => pack.logicalDocuments.map((document) => document.path))
    );
    packs.push(createClosedVersionAuditPack(
      logicalDocuments.filter((document) => !alreadyPackedPaths.has(document.path)),
      packClosedVersionId,
      version.closedAt
    ));
  }
  const physical = buildAuditPhysicalDocuments(logicalDocuments, packs);
  await applyRouteLedgerJsonReplacement(
    absoluteOutputRoot,
    logicalDocuments,
    physical.documents,
    writeLockOwnerId
  );

  return {
    outputRoot: absoluteOutputRoot,
    logicalDocumentCount: logicalDocuments.length,
    physicalDocumentCount: physical.documents.length,
    operationEnvelopeCount: physical.operationEnvelopeCount,
    auditPackCount: packs.length,
    packedDocumentCount: packs.reduce((count, pack) => count + pack.logicalDocuments.length, 0)
  };
};

export const exportProjectAggregateToJsonDirectory = async ({
  outputRoot,
  snapshot,
  overwrite = false
}: ExportProjectAggregateToJsonDirectoryOptions): Promise<WriteRouteLedgerJsonDocumentsResult> =>
  writeRouteLedgerJsonDocuments({
    outputRoot,
    documents: encodeProjectAggregateToJsonDocuments(snapshot),
    overwrite
  });

export const readRouteLedgerJsonDocuments = async (
  inputRoot: string,
  options: RouteLedgerJsonReadOptions = {}
): Promise<RouteLedgerJsonDocument[]> => {
  const absoluteInputRoot = path.resolve(inputRoot);
  await recoverRouteLedgerJsonReplacement(absoluteInputRoot, options);
  return readCanonicalDocumentsFromJsonRoot(getAbsoluteJsonRoot(absoluteInputRoot));
};
