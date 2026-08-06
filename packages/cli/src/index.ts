import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ApplicationError,
  BATCH_CREATE_VERSIONS_MODES,
  BATCH_PREVIOUS_CURRENT_POLICIES,
  DomainError,
  ROUTE_OPERATION_WORKFLOW_MODES,
  RouteLedgerService,
  type Actor,
  type BatchCreateVersionsMode,
  type BatchPreviousCurrentPolicy,
  type Constraint,
  type DeferredItem,
  type ProjectAggregateSnapshot,
  type StoragePort,
  type Todo,
  isBatchCreateVersionsMode,
  isBatchPreviousCurrentPolicy,
  isRouteOperationWorkflowMode,
  type L3ActionType
} from "@routeledger/core";
import {
  RouteLedgerJsonImportError,
  RouteLedgerJsonReviewSummaryError,
  RouteLedgerJsonWriteError,
  buildProjectAggregateReviewSummary,
  encodeProjectAggregateToJsonDocuments,
  exportProjectAggregateToJsonDirectory,
  loadValidatedProjectAggregateFromJsonDirectory,
  readRouteLedgerJsonDocuments,
  runRouteLedgerJsonMergeCheck,
  validateRouteLedgerJsonDocuments
} from "@routeledger/json";
import { SQLiteStorageAdapter } from "@routeledger/sqlite";

export interface RunCliOptions {
  argv: string[];
  projectRoot: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

type CliResponse =
  | {
      ok: true;
      data: unknown;
      meta?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      meta?: Record<string, unknown>;
    };

class CliCommandError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliCommandError";
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_ACTOR: Actor = {
  id: "cli-agent",
  type: "agent",
  displayName: "routeledger-cli"
};

const DEFAULT_APPROVER: Actor = {
  id: "cli-user",
  type: "user",
  displayName: "routeledger-cli-user"
};

const DEFERRED_RESOLUTION_OUTCOMES = [
  "superseded",
  "rejected",
  "out_of_scope"
] as const;

const LEGACY_STRUCTURE_ACTION_TYPES = new Set([
  "create_undo",
  "carry_forward_undo"
]);

const summarizeTodoForCli = (todo: Todo) => ({
  id: todo.id,
  projectId: todo.projectId,
  versionId: todo.versionId,
  title: todo.title,
  description: todo.description,
  status: todo.status,
  sourceType: todo.sourceType,
  sourceId: todo.sourceId,
  createdBy: todo.createdBy,
  createdAt: todo.createdAt,
  updatedAt: todo.updatedAt,
  closedAt: todo.closedAt,
  closeReason: todo.closeReason,
  closeNote: todo.closeNote
});

const summarizeDeferredForCli = (deferred: DeferredItem) => ({
  id: deferred.id,
  projectId: deferred.projectId,
  targetReviewVersionId: deferred.targetReviewVersionId,
  title: deferred.title,
  description: deferred.description,
  status: deferred.status,
  reason: deferred.reason,
  reviewTrigger: deferred.reviewTrigger,
  resolutionOutcome: deferred.resolutionOutcome,
  resolutionReason: deferred.resolutionReason,
  resolutionNote: deferred.resolutionNote,
  decisionRef: deferred.decisionRef,
  activatedTodoId: deferred.activatedTodoId,
  createdBy: deferred.createdBy,
  createdAt: deferred.createdAt,
  updatedAt: deferred.updatedAt,
  reviewedAt: deferred.reviewedAt
});

const summarizeConstraintForCli = (constraint: Constraint) => ({
  id: constraint.id,
  projectId: constraint.projectId,
  rule: constraint.rule,
  rationale: constraint.rationale,
  scope: constraint.scope,
  status: constraint.status,
  createdBy: constraint.createdBy,
  createdAt: constraint.createdAt,
  updatedAt: constraint.updatedAt,
  retiredAt: constraint.retiredAt,
  retireReason: constraint.retireReason,
  retireNote: constraint.retireNote
});

const sanitizeLegacyGateBlockers = (
  blockers: unknown
): Array<Record<string, unknown>> =>
  (Array.isArray(blockers) ? blockers : []).map(
    (blocker: Record<string, unknown>) => {
      if (
        typeof blocker.code !== "string" ||
        !blocker.code.includes("UNDO")
      ) {
        return blocker;
      }

      return {
        code: "LEGACY_WORK_REQUIRES_AUDIT",
        message:
          "Legacy work blocks this operation; run context --include-legacy-undo for audit details.",
        recordCount: Array.isArray(blocker.recordIds)
          ? blocker.recordIds.length
          : 0
      };
    }
  );

const sanitizeVersionStructureOperationForCli = (
  operation: Record<string, any>
): Record<string, unknown> => {
  const sanitized = structuredClone(operation) as Record<string, any>;
  sanitized.blockers = sanitizeLegacyGateBlockers(sanitized.blockers);

  if (sanitized.details !== null && typeof sanitized.details === "object") {
    const details = sanitized.details as Record<string, any>;

    if (Array.isArray(details.unresolvedUndoIds)) {
      details.legacyBlockerCount = details.unresolvedUndoIds.length;
      delete details.unresolvedUndoIds;
    }

    if (
      details.ordinaryCloseGate !== null &&
      typeof details.ordinaryCloseGate === "object"
    ) {
      const ordinaryCloseGate = details.ordinaryCloseGate as Record<
        string,
        any
      >;

      if (Array.isArray(ordinaryCloseGate.unresolvedUndoIds)) {
        ordinaryCloseGate.legacyBlockerCount =
          ordinaryCloseGate.unresolvedUndoIds.length;
        delete ordinaryCloseGate.unresolvedUndoIds;
      }

      if (Array.isArray(ordinaryCloseGate.blockerCodes)) {
        ordinaryCloseGate.blockerCodes = [
          ...new Set(
            ordinaryCloseGate.blockerCodes.map((code: unknown) =>
              typeof code === "string" && code.includes("UNDO")
                ? "LEGACY_WORK_REQUIRES_AUDIT"
                : code
            )
          )
        ];
      }
    }
  }

  return sanitized;
};

const sanitizeVersionStructureForCli = (
  structure: unknown
): Record<string, unknown> => {
  const sanitized = structuredClone(structure) as Record<string, any>;
  const legalOperations = Array.isArray(sanitized.legalOperations)
    ? sanitized.legalOperations
    : [];
  const openUndos =
    sanitized.openUndos !== null && typeof sanitized.openUndos === "object"
      ? (sanitized.openUndos as Record<string, unknown>)
      : {};
  const legacyRecordIds = new Set(
    ["owned", "origin", "preferredResolution"].flatMap((field) =>
      Array.isArray(openUndos[field])
        ? (openUndos[field] as Array<{ id?: unknown }>)
            .map((record) => record.id)
            .filter((id): id is string => typeof id === "string")
        : []
    )
  );

  delete sanitized.openUndos;
  sanitized.legalOperations = legalOperations
    .filter(
      (operation: Record<string, unknown>) =>
        !LEGACY_STRUCTURE_ACTION_TYPES.has(String(operation.actionType))
    )
    .map(sanitizeVersionStructureOperationForCli);

  if (legacyRecordIds.size > 0) {
    sanitized.legacyAudit = {
      required: true,
      recordCount: legacyRecordIds.size,
      guidance:
        "Run context --include-legacy-undo for audit details before choosing Todo, Deferred, Constraint, or a resolved outcome."
    };
  }

  return sanitized;
};

const emitLine = (writer: ((line: string) => void) | undefined, payload: CliResponse): void => {
  writer?.(JSON.stringify(payload));
};

const getFlagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.findIndex((argument) => argument === name);

  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
};

const hasFlag = (argv: string[], name: string): boolean => argv.includes(name);

const requireFlagValue = (argv: string[], name: string): string => {
  const value = getFlagValue(argv, name);

  if (value === undefined || value.startsWith("--")) {
    throw new ApplicationError("PROJECT_NOT_FOUND", `缺少参数 ${name}`);
  }

  return value;
};

const getOptionalFlagValue = (argv: string[], name: string): string | undefined => {
  if (!hasFlag(argv, name)) {
    return undefined;
  }

  return requireFlagValue(argv, name);
};

const requireSemanticFlagValue = (argv: string[], name: string): string => {
  const value = getFlagValue(argv, name);

  if (value === undefined || value.startsWith("--")) {
    throw new CliCommandError("INVALID_ARGUMENT", `缺少参数 ${name}`, {
      flag: name
    });
  }

  return value;
};

const requireEnumFlagValue = <T extends string>(
  argv: string[],
  name: string,
  allowedValues: readonly T[]
): T => {
  const value = requireSemanticFlagValue(argv, name);

  if (!allowedValues.includes(value as T)) {
    throw new CliCommandError(
      "INVALID_ARGUMENT",
      `${name} 仅支持 ${allowedValues.join("、")}`,
      {
        flag: name,
        value,
        allowedValues: [...allowedValues]
      }
    );
  }

  return value as T;
};

const parseJsonFlag = <T>(argv: string[], name: string): T | undefined => {
  const value = getFlagValue(argv, name);

  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(value) as T;
};

const createStorage = (projectRoot: string): SQLiteStorageAdapter =>
  new SQLiteStorageAdapter({
    projectRoot
  });

class ReadOnlySnapshotStorageAdapter implements StoragePort {
  private readonly snapshot: ProjectAggregateSnapshot;

  constructor(snapshot: ProjectAggregateSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  async loadProjectAggregate(projectId: string): Promise<ProjectAggregateSnapshot | null> {
    return this.snapshot.project.id === projectId ? structuredClone(this.snapshot) : null;
  }

  async saveProjectAggregate(): Promise<void> {
    throw new Error("ReadOnlySnapshotStorageAdapter does not support writes");
  }
}

const createService = (storage: StoragePort): RouteLedgerService => {
  const service = new RouteLedgerService({
    storage,
    deps: {
      clock: {
        now: () => new Date().toISOString()
      },
      idGenerator: {
        nextId: () => randomUUID()
      }
    }
  });

  return service;
};

const parseBooleanFlag = (argv: string[], name: string): boolean | undefined => {
  const value = getFlagValue(argv, name);

  if (value === undefined) {
    return hasFlag(argv, name) ? true : undefined;
  }

  return value === "true";
};

const parseIntegerFlag = (argv: string[], name: string): number | undefined => {
  const value = getFlagValue(argv, name);

  if (value === undefined) {
    if (hasFlag(argv, name)) {
      requireFlagValue(argv, name);
    }

    return undefined;
  }

  if (!/^[-]?\d+$/.test(value)) {
    throw new CliCommandError("INVALID_ARGUMENT", `Argument ${name} must be an integer`, {
      flag: name,
      value
    });
  }

  return Number.parseInt(value, 10);
};

const parseBatchCreateVersionsModeFlag = (value: string): BatchCreateVersionsMode => {
  if (isBatchCreateVersionsMode(value)) {
    return value;
  }

  throw new ApplicationError(
    "BATCH_CREATE_VERSIONS_MODE_INVALID",
    "batch_create_versions 的 --mode 仅支持 preflight 或 propose",
    {
      flag: "--mode",
      receivedMode: value,
      allowedModes: [...BATCH_CREATE_VERSIONS_MODES]
    }
  );
};

const getExecFileFailureMessage = (error: unknown): string => {
  if (error instanceof Error && "stderr" in error) {
    const stderr = (error as Error & { stderr?: Buffer | string }).stderr;

    if (typeof stderr === "string" && stderr.trim().length > 0) {
      return stderr.trim();
    }

    if (stderr instanceof Buffer && stderr.length > 0) {
      return stderr.toString("utf8").trim();
    }
  }

  return error instanceof Error ? error.message : String(error);
};

const ensureGitRefHasCanonicalRouteLedger = (
  repoRoot: string,
  ref: string,
  side: "base" | "head"
): void => {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repoRoot,
      stdio: "pipe"
    });
  } catch (error) {
    throw new CliCommandError(
      "JSON_REVIEW_SUMMARY_REF_INVALID",
      `${side} ref 不存在或非法：${ref}`,
      {
        side,
        ref,
        repoRoot: path.resolve(repoRoot),
        cause: getExecFileFailureMessage(error)
      }
    );
  }

  for (const requiredPath of [".routeledger/project.json", ".routeledger/refs/current.json"]) {
    try {
      execFileSync("git", ["cat-file", "-e", `${ref}:${requiredPath}`], {
        cwd: repoRoot,
        stdio: "ignore"
      });
    } catch (error) {
      throw new CliCommandError(
        "JSON_REVIEW_SUMMARY_REF_MISSING_ROUTELEDGER",
        `${side} ref 缺少 canonical .routeledger 文档：${requiredPath}`,
        {
          side,
          ref,
          missingPath: requiredPath,
          repoRoot: path.resolve(repoRoot),
          cause: getExecFileFailureMessage(error)
        }
      );
    }
  }
};

const loadSnapshotFromGitRef = async (
  repoRoot: string,
  ref: string,
  side: "base" | "head"
) => {
  ensureGitRefHasCanonicalRouteLedger(repoRoot, ref, side);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `routeledger-review-summary-${side}-`));
  const archivePath = path.join(tempRoot, `${side}.tar`);

  try {
    execFileSync("git", ["archive", "--format=tar", `--output=${archivePath}`, ref, ".routeledger"], {
      cwd: repoRoot,
      stdio: "pipe"
    });
    execFileSync("tar", ["-xf", archivePath, "-C", tempRoot], {
      cwd: repoRoot,
      stdio: "pipe"
    });

    return {
      tempRoot,
      ...(await loadValidatedProjectAggregateFromJsonDirectory(tempRoot))
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
};

const parseBatchPreviousCurrentPolicyFlag = (
  value: string | undefined
): BatchPreviousCurrentPolicy | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (isBatchPreviousCurrentPolicy(value)) {
    return value;
  }

  throw new ApplicationError(
    "BATCH_CREATE_VERSIONS_PREVIOUS_CURRENT_POLICY_INVALID",
    "batch_create_versions 的 --previous-current-policy 仅支持 leave_as_is 或 require_complete_or_close",
    {
      flag: "--previous-current-policy",
      receivedPreviousCurrentPolicy: value,
      allowedPreviousCurrentPolicies: [...BATCH_PREVIOUS_CURRENT_POLICIES]
    }
  );
};

const parseRouteOperationWorkflowModeFlag = (
  value: string | undefined
): "dry_run" | "propose" | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (isRouteOperationWorkflowMode(value)) {
    return value;
  }

  throw new ApplicationError(
    "ROUTE_OPERATION_WORKFLOW_MODE_INVALID",
    "workflow mode 仅支持 dry_run 或 propose",
    {
      flag: "--mode",
      receivedMode: value,
      allowedModes: [...ROUTE_OPERATION_WORKFLOW_MODES]
    }
  );
};

const summarizeAggregateCounts = (snapshot: {
  versions: unknown[];
  todos: unknown[];
  deferredItems: unknown[];
  constraints: unknown[];
  undos: unknown[];
  assets: unknown[];
  events: unknown[];
  pendingOperations: unknown[];
  approvalArtifacts: unknown[];
}): Record<string, number> => ({
  versions: snapshot.versions.length,
  todos: snapshot.todos.length,
  deferredItems: snapshot.deferredItems.length,
  constraints: snapshot.constraints.length,
  legacyUndoRecords: snapshot.undos.length,
  assets: snapshot.assets.length,
  events: snapshot.events.length,
  pendingOperations: snapshot.pendingOperations.length,
  approvalArtifacts: snapshot.approvalArtifacts.length
});

const findDocumentContentMismatches = (
  leftDocuments: Array<{ path: string; content: string }>,
  rightDocuments: Array<{ path: string; content: string }>
): string[] => {
  const rightByPath = new Map(rightDocuments.map((document) => [document.path, document.content]));
  const leftPaths = new Set(leftDocuments.map((document) => document.path));
  const rightPaths = new Set(rightDocuments.map((document) => document.path));
  const mismatches = new Set<string>();

  for (const document of leftDocuments) {
    if (rightByPath.get(document.path) !== document.content) {
      mismatches.add(document.path);
    }
  }

  for (const document of rightDocuments) {
    if (!leftPaths.has(document.path)) {
      mismatches.add(document.path);
    }
  }

  for (const document of leftDocuments) {
    if (!rightPaths.has(document.path)) {
      mismatches.add(document.path);
    }
  }

  return [...mismatches].sort((left, right) => left.localeCompare(right, "en"));
};

const handleCommand = async ({
  projectRoot,
  argv,
  getStorage,
  getService
}: {
  projectRoot: string;
  argv: string[];
  getStorage: () => SQLiteStorageAdapter;
  getService: () => RouteLedgerService;
}): Promise<CliResponse> => {
  const [command, subcommand, nested] = argv;

  switch (command) {
    case "init_project": {
      const service = getService();
      const name = requireFlagValue(argv, "--name");
      const description = getFlagValue(argv, "--description");
      const created = await service.initProject({
        name,
        description,
        actor: DEFAULT_ACTOR
      });

      return {
        ok: true,
        data: created
      };
    }
    case "context": {
      const service = getService();
      const projectId = requireFlagValue(argv, "--project-id");
      const context = await service.getCurrentContext({
        projectId,
        includeAllVersions: hasFlag(argv, "--include-all-versions"),
        versionWindowBefore: parseIntegerFlag(argv, "--version-window-before"),
        versionWindowAfter: parseIntegerFlag(argv, "--version-window-after"),
        includeLegacyUndo: hasFlag(argv, "--include-legacy-undo")
      });

      return {
        ok: true,
        data: context.data,
        meta: context.meta
      };
    }
    case "versions": {
      const service = getService();
      if (subcommand !== "list") {
        throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "仅支持 versions list");
      }

      const projectId = requireFlagValue(argv, "--project-id");
      const versions = await service.listVersions(projectId);

      return {
        ok: true,
        data: versions
      };
    }
    case "batch_create_versions": {
      const service = getService();
      const projectId = requireFlagValue(argv, "--project-id");
      const mode = parseBatchCreateVersionsModeFlag(requireFlagValue(argv, "--mode"));

      return {
        ok: true,
        data: await service.batchCreateVersions({
          projectId,
          mode,
          partialAllowed: parseBooleanFlag(argv, "--partial-allowed"),
          anchor: parseJsonFlag(argv, "--anchor-json"),
          items: parseJsonFlag(argv, "--items-json") ?? [],
          setCurrentTo: getFlagValue(argv, "--set-current-to"),
          previousCurrentPolicy: parseBatchPreviousCurrentPolicyFlag(
            getFlagValue(argv, "--previous-current-policy")
          ),
          reason: getFlagValue(argv, "--reason"),
          actor: DEFAULT_ACTOR
        })
      };
    }
    case "transition_version": {
      const service = getService();
      return {
        ok: true,
        data: await service.transitionVersion({
          projectId: requireFlagValue(argv, "--project-id"),
          versionId: requireFlagValue(argv, "--version-id"),
          mode: parseRouteOperationWorkflowModeFlag(getFlagValue(argv, "--mode")),
          reason: getFlagValue(argv, "--reason"),
          actor: DEFAULT_ACTOR
        })
      };
    }
    case "close_version": {
      const service = getService();
      return {
        ok: true,
        data: await service.closeVersionWorkflow({
          projectId: requireFlagValue(argv, "--project-id"),
          versionId: requireFlagValue(argv, "--version-id"),
          mode: parseRouteOperationWorkflowModeFlag(getFlagValue(argv, "--mode")),
          residualAudit: parseJsonFlag(argv, "--residual-audit-json") ?? [],
          reason: getFlagValue(argv, "--reason"),
          actor: DEFAULT_ACTOR
        })
      };
    }
    case "shutdown_version": {
      const service = getService();
      const shutdownReason =
        getOptionalFlagValue(argv, "--shutdown-reason") ??
        getOptionalFlagValue(argv, "--reason") ??
        requireFlagValue(argv, "--shutdown-reason");
      const reason =
        hasFlag(argv, "--shutdown-reason") ? getOptionalFlagValue(argv, "--reason") : undefined;

      return {
        ok: true,
        data: await service.shutdownVersionWorkflow({
          projectId: requireFlagValue(argv, "--project-id"),
          versionId: requireFlagValue(argv, "--version-id"),
          mode: parseRouteOperationWorkflowModeFlag(getFlagValue(argv, "--mode")),
          shutdownReason,
          reason,
          actor: DEFAULT_ACTOR
        })
      };
    }
    case "get_version_transition_guide": {
      const loaded = await loadValidatedProjectAggregateFromJsonDirectory(projectRoot);
      const service = createService(new ReadOnlySnapshotStorageAdapter(loaded.snapshot));

      return {
        ok: true,
        data: await service.getVersionTransitionGuide({
          projectId: requireFlagValue(argv, "--project-id"),
          fromVersionId: getFlagValue(argv, "--from-version-id"),
          targetVersionId: requireFlagValue(argv, "--target-version-id"),
          residualAudit: parseJsonFlag(argv, "--residual-audit-json") ?? []
        }),
        meta: {
          source: "canonical_json",
          inputDir: loaded.jsonRoot,
          documentCount: loaded.documentCount
        }
      };
    }
    // Legacy compatibility only: these commands remain direct-callable for
    // existing scripts and stored records, but are not the Deferred workflow.
    case "carry_forward_undo": {
      const service = getService();
      return {
        ok: true,
        data: await service.carryForwardUndo({
          projectId: requireFlagValue(argv, "--project-id"),
          undoId: requireFlagValue(argv, "--undo-id"),
          preferredResolutionVersionId: requireFlagValue(
            argv,
            "--preferred-resolution-version-id"
          ),
          reason: requireFlagValue(argv, "--reason"),
          note: requireFlagValue(argv, "--note"),
          actor: DEFAULT_ACTOR
        })
      };
    }
    case "resolve_undo_as_downstream_input": {
      const service = getService();
      return {
        ok: true,
        data: await service.resolveUndoAsDownstreamInput({
          projectId: requireFlagValue(argv, "--project-id"),
          undoId: requireFlagValue(argv, "--undo-id"),
          preferredResolutionVersionId: requireFlagValue(
            argv,
            "--preferred-resolution-version-id"
          ),
          reason: requireFlagValue(argv, "--reason"),
          note: requireFlagValue(argv, "--note"),
          actor: DEFAULT_ACTOR
        })
      };
    }
    case "get_version_structure": {
      const service = getService();
      const includeLegacyUndo = hasFlag(argv, "--include-legacy-undo");
      const structure = await service.getVersionStructure({
        projectId: requireFlagValue(argv, "--project-id"),
        versionId: getFlagValue(argv, "--version-id"),
        residualAudit: parseJsonFlag(argv, "--residual-audit-json") ?? []
      });

      return {
        ok: true,
        data: includeLegacyUndo
          ? structure
          : sanitizeVersionStructureForCli(structure)
      };
    }
    case "gate": {
      const service = getService();
      const projectId = requireFlagValue(argv, "--project-id");
      const versionId = requireFlagValue(argv, "--version-id");

      if (subcommand === "check-start") {
        return {
          ok: true,
          data: await service.checkStartGate({
            projectId,
            versionId,
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "check-close") {
        return {
          ok: true,
          data: await service.checkCloseGate({
            projectId,
            versionId,
            residualAudit: parseJsonFlag(argv, "--residual-audit-json") ?? [],
            actor: DEFAULT_ACTOR
          })
        };
      }

      throw new ApplicationError(
        "ACTION_NOT_IMPLEMENTED",
        "仅支持 gate check-start/check-close"
      );
    }
    case "todo": {
      const service = getService();
      if (subcommand === "create") {
        const created = await service.createTodo({
          projectId: requireFlagValue(argv, "--project-id"),
          versionId: requireFlagValue(argv, "--version-id"),
          title: requireFlagValue(argv, "--title"),
          description: getFlagValue(argv, "--description"),
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: created
        };
      }

      if (subcommand === "close") {
        const closed = await service.closeTodo({
          projectId: requireFlagValue(argv, "--project-id"),
          todoId: requireFlagValue(argv, "--todo-id"),
          reason: requireFlagValue(argv, "--reason"),
          note: requireFlagValue(argv, "--note"),
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: closed
        };
      }

      throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "仅支持 todo create/close");
    }
    case "deferred": {
      const service = getService();
      const projectId = requireSemanticFlagValue(argv, "--project-id");

      if (subcommand === "create") {
        const result = await service.deferWork({
          mode: "new",
          projectId,
          originVersionId: requireSemanticFlagValue(argv, "--current-version-id"),
          targetReviewVersionId: requireSemanticFlagValue(
            argv,
            "--target-review-version-id"
          ),
          title: requireSemanticFlagValue(argv, "--title"),
          description: getOptionalFlagValue(argv, "--description"),
          reason: requireSemanticFlagValue(argv, "--reason"),
          reviewTrigger: getOptionalFlagValue(argv, "--review-trigger"),
          actor: DEFAULT_ACTOR
        });

        if (result.mode !== "new") {
          throw new ApplicationError(
            "ACTION_NOT_IMPLEMENTED",
            "deferred create 返回了错误 mode"
          );
        }

        return {
          ok: true,
          data: {
            mode: result.mode,
            deferred: summarizeDeferredForCli(result.deferred)
          }
        };
      }

      if (subcommand === "from-todo") {
        const result = await service.deferWork({
          mode: "todo",
          projectId,
          todoId: requireSemanticFlagValue(argv, "--todo-id"),
          targetReviewVersionId: requireSemanticFlagValue(
            argv,
            "--target-review-version-id"
          ),
          reason: requireSemanticFlagValue(argv, "--reason"),
          note: requireSemanticFlagValue(argv, "--note"),
          reviewTrigger: getOptionalFlagValue(argv, "--review-trigger"),
          actor: DEFAULT_ACTOR
        });

        if (result.mode !== "todo") {
          throw new ApplicationError(
            "ACTION_NOT_IMPLEMENTED",
            "deferred from-todo 返回了错误 mode"
          );
        }

        return {
          ok: true,
          data: {
            mode: result.mode,
            todo: summarizeTodoForCli(result.todo),
            deferred: summarizeDeferredForCli(result.deferred)
          }
        };
      }

      if (subcommand === "activate") {
        const result = await service.reviewDeferred({
          action: "activate",
          projectId,
          deferredId: requireSemanticFlagValue(argv, "--deferred-id"),
          targetVersionId: requireSemanticFlagValue(argv, "--target-version-id"),
          reason: requireSemanticFlagValue(argv, "--reason"),
          note: getOptionalFlagValue(argv, "--note"),
          actor: DEFAULT_ACTOR
        });

        if (result.action !== "activate") {
          throw new ApplicationError(
            "ACTION_NOT_IMPLEMENTED",
            "deferred activate 返回了错误 action"
          );
        }

        return {
          ok: true,
          data: {
            action: result.action,
            deferred: summarizeDeferredForCli(result.deferred),
            todo: summarizeTodoForCli(result.todo)
          }
        };
      }

      if (subcommand === "defer-again") {
        const result = await service.reviewDeferred({
          action: "defer_again",
          projectId,
          deferredId: requireSemanticFlagValue(argv, "--deferred-id"),
          targetReviewVersionId: requireSemanticFlagValue(
            argv,
            "--target-review-version-id"
          ),
          reason: requireSemanticFlagValue(argv, "--reason"),
          note: getOptionalFlagValue(argv, "--note"),
          reviewTrigger: getOptionalFlagValue(argv, "--review-trigger"),
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: {
            action: result.action,
            deferred: summarizeDeferredForCli(result.deferred)
          }
        };
      }

      if (subcommand === "resolve") {
        const result = await service.reviewDeferred({
          action: "resolve",
          projectId,
          deferredId: requireSemanticFlagValue(argv, "--deferred-id"),
          outcome: requireEnumFlagValue(
            argv,
            "--outcome",
            DEFERRED_RESOLUTION_OUTCOMES
          ),
          reason: requireSemanticFlagValue(argv, "--reason"),
          note: requireSemanticFlagValue(argv, "--note"),
          decisionRef: getOptionalFlagValue(argv, "--decision-ref"),
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: {
            action: result.action,
            deferred: summarizeDeferredForCli(result.deferred)
          }
        };
      }

      throw new ApplicationError(
        "ACTION_NOT_IMPLEMENTED",
        "仅支持 deferred create/from-todo/activate/defer-again/resolve"
      );
    }
    case "constraint": {
      const service = getService();
      const projectId = requireSemanticFlagValue(argv, "--project-id");

      if (subcommand === "record") {
        const scopeType = requireEnumFlagValue(
          argv,
          "--scope",
          ["project", "version"] as const
        );
        const versionId = getOptionalFlagValue(argv, "--version-id");

        if (scopeType === "project" && versionId !== undefined) {
          throw new CliCommandError(
            "INVALID_ARGUMENT",
            "--version-id 仅适用于 --scope version",
            {
              flag: "--version-id",
              scope: scopeType
            }
          );
        }

        const result = await service.recordConstraint({
          projectId,
          rule: requireSemanticFlagValue(argv, "--rule"),
          rationale: requireSemanticFlagValue(argv, "--rationale"),
          scope:
            scopeType === "project"
              ? { type: "project" }
              : {
                  type: "version",
                  versionId: requireSemanticFlagValue(argv, "--version-id")
                },
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: {
            constraint: summarizeConstraintForCli(result.constraint)
          }
        };
      }

      if (subcommand === "retire") {
        const result = await service.retireConstraint({
          projectId,
          constraintId: requireSemanticFlagValue(argv, "--constraint-id"),
          reason: requireSemanticFlagValue(argv, "--reason"),
          note: requireSemanticFlagValue(argv, "--note"),
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: {
            constraint: summarizeConstraintForCli(result.constraint)
          }
        };
      }

      throw new ApplicationError(
        "ACTION_NOT_IMPLEMENTED",
        "仅支持 constraint record/retire"
      );
    }
    // Legacy compatibility only: preserve existing scripts and stored-data
    // operations, but do not use these commands as the default deferred-work path.
    case "undo": {
      const service = getService();
      if (subcommand === "create") {
        const created = await service.createUndo({
          projectId: requireFlagValue(argv, "--project-id"),
          versionId: requireFlagValue(argv, "--version-id"),
          originVersionId: requireFlagValue(argv, "--origin-version-id"),
          preferredResolutionVersionId: requireFlagValue(
            argv,
            "--preferred-resolution-version-id"
          ),
          title: requireFlagValue(argv, "--title"),
          reason: requireFlagValue(argv, "--reason"),
          description: getFlagValue(argv, "--description"),
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: created
        };
      }

      if (subcommand === "reassign") {
        const reassigned = await service.reassignUndo({
          projectId: requireFlagValue(argv, "--project-id"),
          undoId: requireFlagValue(argv, "--undo-id"),
          preferredResolutionVersionId: requireFlagValue(
            argv,
            "--preferred-resolution-version-id"
          ),
          reason: requireFlagValue(argv, "--reason"),
          note: requireFlagValue(argv, "--note"),
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: reassigned
        };
      }

      if (subcommand === "close") {
        const closed = await service.closeUndo({
          projectId: requireFlagValue(argv, "--project-id"),
          undoId: requireFlagValue(argv, "--undo-id"),
          reason: requireFlagValue(argv, "--reason"),
          note: requireFlagValue(argv, "--note"),
          actor: DEFAULT_ACTOR
        });

        return {
          ok: true,
          data: closed
        };
      }

      throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "仅支持 undo create/reassign/close");
    }
    case "version": {
      const service = getService();
      const projectId = requireFlagValue(argv, "--project-id");

      if (subcommand === "prepare") {
        const versionId = requireFlagValue(argv, "--version-id");
        return {
          ok: true,
          data: await service.prepareVersion({
            projectId,
            versionId,
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "complete") {
        const versionId = requireFlagValue(argv, "--version-id");
        return {
          ok: true,
          data: await service.markVersionComplete({
            projectId,
            versionId,
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "start") {
        const versionId = requireFlagValue(argv, "--version-id");
        return {
          ok: true,
          data: await service.startVersion({
            projectId,
            versionId,
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "close") {
        const versionId = requireFlagValue(argv, "--version-id");
        return {
          ok: true,
          data: await service.closeVersion({
            projectId,
            versionId,
            residualAudit: parseJsonFlag(argv, "--residual-audit-json") ?? [],
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "reopen") {
        const versionId = requireFlagValue(argv, "--version-id");
        return {
          ok: true,
          data: await service.reopenVersion({
            projectId,
            versionId,
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "current" && nested === "set") {
        const versionId = requireFlagValue(argv, "--version-id");
        return {
          ok: true,
          data: await service.setCurrentVersion({
            projectId,
            versionId,
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "create") {
        return {
          ok: true,
          data: await service.createVersion({
            projectId,
            title: requireFlagValue(argv, "--title"),
            description: getFlagValue(argv, "--description"),
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "insert") {
        return {
          ok: true,
          data: await service.insertVersion({
            projectId,
            title: requireFlagValue(argv, "--title"),
            description: getFlagValue(argv, "--description"),
            afterVersionId: getFlagValue(argv, "--after-version-id"),
            beforeVersionId: getFlagValue(argv, "--before-version-id"),
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "child" && nested === "create") {
        return {
          ok: true,
          data: await service.createChildVersion({
            projectId,
            parentVersionId: requireFlagValue(argv, "--parent-version-id"),
            title: requireFlagValue(argv, "--title"),
            description: getFlagValue(argv, "--description"),
            afterVersionId: getFlagValue(argv, "--after-version-id"),
            beforeVersionId: getFlagValue(argv, "--before-version-id"),
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "reorder") {
        return {
          ok: true,
          data: await service.reorderVersions({
            projectId,
            versionId: requireFlagValue(argv, "--version-id"),
            afterVersionId: getFlagValue(argv, "--after-version-id"),
            beforeVersionId: getFlagValue(argv, "--before-version-id"),
            actor: DEFAULT_ACTOR
          })
        };
      }

      throw new ApplicationError(
        "ACTION_NOT_IMPLEMENTED",
        "仅支持 version prepare/complete/start/close/reopen/current set/create/insert/child create/reorder"
      );
    }
    case "l3": {
      const service = getService();
      const projectId = requireFlagValue(argv, "--project-id");

      if (subcommand === "propose") {
        return {
          ok: true,
          data: await service.proposeL3Operation({
            projectId,
            actionType: requireFlagValue(argv, "--action-type") as L3ActionType,
            targetId: requireFlagValue(argv, "--target-id"),
            reason: requireFlagValue(argv, "--reason"),
            payload: parseJsonFlag(argv, "--payload-json") ?? {},
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "approve") {
        return {
          ok: true,
          data: await service.approveL3Operation({
            projectId,
            pendingOperationId: requireFlagValue(argv, "--pending-operation-id"),
            approver: DEFAULT_APPROVER,
            actor: DEFAULT_ACTOR,
            decisionRef: getFlagValue(argv, "--decision-ref")
          })
        };
      }

      if (subcommand === "commit") {
        return {
          ok: true,
          data: await service.commitL3Operation({
            projectId,
            pendingOperationId: requireFlagValue(argv, "--pending-operation-id"),
            approvalArtifactId: getFlagValue(argv, "--approval-artifact-id"),
            confirm: parseBooleanFlag(argv, "--confirm"),
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "reject") {
        return {
          ok: true,
          data: await service.rejectL3Operation({
            projectId,
            pendingOperationId: requireFlagValue(argv, "--pending-operation-id"),
            reason: requireFlagValue(argv, "--reason"),
            actor: DEFAULT_ACTOR
          })
        };
      }

      if (subcommand === "list") {
        return {
          ok: true,
          data: await service.listL3Proposals(projectId)
        };
      }

      if (subcommand === "get") {
        return {
          ok: true,
          data: await service.getL3Proposal(
            projectId,
            requireFlagValue(argv, "--pending-operation-id")
          )
        };
      }

      throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "仅支持 l3 propose/approve/commit/reject/list/get");
    }
    case "json": {
      if (subcommand === "merge-check") {
        const inputRoot = getFlagValue(argv, "--input-dir") ?? projectRoot;
        const mergeCheck = await runRouteLedgerJsonMergeCheck(inputRoot);

        if (!mergeCheck.valid) {
          throw new CliCommandError("JSON_MERGE_CHECK_FAILED", "JSON merge-check 发现错误", {
            inputDir: mergeCheck.jsonRoot,
            documentCount: mergeCheck.documentCount,
            issues: mergeCheck.issues
          });
        }

        return {
          ok: true,
          data: {
            valid: true,
            issues: mergeCheck.issues
          },
          meta: {
            inputDir: mergeCheck.jsonRoot,
            documentCount: mergeCheck.documentCount
          }
        };
      }

      if (subcommand === "validate") {
        const inputRoot = getFlagValue(argv, "--input-dir") ?? projectRoot;
        const documents = await readRouteLedgerJsonDocuments(inputRoot);
        const validation = validateRouteLedgerJsonDocuments(documents);

        if (!validation.valid) {
          throw new CliCommandError("JSON_VALIDATION_FAILED", "JSON validate 发现错误", {
            inputDir: path.join(inputRoot, ".routeledger"),
            documentCount: documents.length,
            valid: validation.valid,
            issues: validation.issues
          });
        }

        return {
          ok: true,
          data: {
            valid: true,
            issues: validation.issues
          },
          meta: {
            inputDir: path.join(inputRoot, ".routeledger"),
            documentCount: documents.length
          }
        };
      }

      if (subcommand === "import") {
        const inputRoot = requireFlagValue(argv, "--input-dir");
        const targetProjectRoot = getFlagValue(argv, "--project-root") ?? projectRoot;
        const loaded = await loadValidatedProjectAggregateFromJsonDirectory(inputRoot);
        const sourceDocuments = loaded.documents;
        const canonicalSnapshotDocuments = encodeProjectAggregateToJsonDocuments(loaded.snapshot);
        const nonCanonicalPaths = findDocumentContentMismatches(
          sourceDocuments,
          canonicalSnapshotDocuments
        );

        if (nonCanonicalPaths.length > 0) {
          throw new CliCommandError(
            "JSON_IMPORT_ROUND_TRIP_MISMATCH",
            "输入 JSON 文档集不是 canonical 形式",
            {
              projectId: loaded.snapshot.project.id,
              targetProjectRoot: path.resolve(targetProjectRoot),
              mismatchedPaths: nonCanonicalPaths
            }
          );
        }

        const targetStorage = createStorage(targetProjectRoot);

        try {
          const existingSnapshot = await targetStorage.loadProjectAggregate(loaded.snapshot.project.id);

          if (existingSnapshot !== null) {
            throw new CliCommandError(
              "JSON_IMPORT_TARGET_EXISTS",
              "target SQLite project 已存在同 id project",
              {
                projectId: loaded.snapshot.project.id,
                inputDir: loaded.jsonRoot,
                targetProjectRoot: path.resolve(targetProjectRoot)
              }
            );
          }

          await targetStorage.saveProjectAggregate(loaded.snapshot);

          const reloadedSnapshot = await targetStorage.loadProjectAggregate(loaded.snapshot.project.id);

          if (reloadedSnapshot === null) {
            throw new CliCommandError("JSON_IMPORT_RELOAD_FAILED", "导入后无法重新读取 SQLite aggregate", {
              projectId: loaded.snapshot.project.id,
              targetProjectRoot: path.resolve(targetProjectRoot)
            });
          }

          const reloadedDocuments = encodeProjectAggregateToJsonDocuments(reloadedSnapshot);
          const mismatchedPaths = findDocumentContentMismatches(sourceDocuments, reloadedDocuments);

          if (mismatchedPaths.length > 0) {
            throw new CliCommandError(
              "JSON_IMPORT_ROUND_TRIP_MISMATCH",
              "Imported SQLite round-trip does not match the source JSON documents",
              {
                projectId: loaded.snapshot.project.id,
                targetProjectRoot: path.resolve(targetProjectRoot),
                mismatchedPaths
              }
            );
          }

          return {
            ok: true,
            data: {
              projectId: reloadedSnapshot.project.id,
              targetProjectRoot: path.resolve(targetProjectRoot),
              ...summarizeAggregateCounts(reloadedSnapshot)
            },
            meta: {
              inputDir: loaded.jsonRoot,
              documentCount: loaded.documentCount,
              roundTripDocumentCount: reloadedDocuments.length
            }
          };
        } finally {
          targetStorage.close();
        }
      }

      if (subcommand === "review-summary") {
        if (hasFlag(argv, "--base-dir") || hasFlag(argv, "--head-dir")) {
          throw new CliCommandError(
            "JSON_REVIEW_SUMMARY_DIR_INPUT_UNSUPPORTED",
            "json review-summary 当前只支持 --base-ref / --head-ref；--base-dir / --head-dir 尚未支持"
          );
        }

        const baseRef = requireFlagValue(argv, "--base-ref");
        const headRef = requireFlagValue(argv, "--head-ref");
        let baseLoaded:
          | (Awaited<ReturnType<typeof loadSnapshotFromGitRef>> & { tempRoot: string })
          | undefined;
        let headLoaded:
          | (Awaited<ReturnType<typeof loadSnapshotFromGitRef>> & { tempRoot: string })
          | undefined;

        try {
          baseLoaded = await loadSnapshotFromGitRef(projectRoot, baseRef, "base");
          headLoaded = await loadSnapshotFromGitRef(projectRoot, headRef, "head");

          return {
            ok: true,
            data: buildProjectAggregateReviewSummary(baseLoaded.snapshot, headLoaded.snapshot, {
              baseLabel: baseRef,
              headLabel: headRef
            }),
            meta: {
              baseRef,
              headRef,
              baseInputDir: baseLoaded.jsonRoot,
              headInputDir: headLoaded.jsonRoot,
              baseDocumentCount: baseLoaded.documentCount,
              headDocumentCount: headLoaded.documentCount
            }
          };
        } finally {
          if (baseLoaded !== undefined) {
            fs.rmSync(baseLoaded.tempRoot, { recursive: true, force: true });
          }

          if (headLoaded !== undefined) {
            fs.rmSync(headLoaded.tempRoot, { recursive: true, force: true });
          }
        }
      }

      if (subcommand !== "export") {
        throw new ApplicationError(
          "ACTION_NOT_IMPLEMENTED",
          "仅支持 json export/validate/import/merge-check/review-summary"
        );
      }

      const storage = getStorage();
      const projectId = requireFlagValue(argv, "--project-id");
      const snapshot = await storage.loadProjectAggregate(projectId);

      if (snapshot === null) {
        throw new ApplicationError("PROJECT_NOT_FOUND", "project does not exist", {
          projectId
        });
      }

      const outputRoot = getFlagValue(argv, "--output-dir") ?? projectRoot;
      const exported = await exportProjectAggregateToJsonDirectory({
        outputRoot,
        snapshot,
        overwrite: hasFlag(argv, "--force")
      });

      return {
        ok: true,
        data: {
          projectId,
          outputDir: exported.jsonRoot
        },
        meta: {
          documentCount: exported.documentCount,
          paths: exported.paths
        }
      };
    }
    default:
      throw new ApplicationError("ACTION_NOT_IMPLEMENTED", "未知命令", {
        argv
      });
  }
};

const toCliError = (error: unknown): CliResponse => {
  if (error instanceof RouteLedgerJsonImportError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  if (error instanceof RouteLedgerJsonReviewSummaryError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  if (error instanceof RouteLedgerJsonWriteError) {
    return {
      ok: false,
      error: {
        code:
          error.code === "DOCUMENT_ALREADY_EXISTS"
            ? "JSON_EXPORT_TARGET_EXISTS"
            : "JSON_EXPORT_PATH_ESCAPE",
        message: error.message,
        details: error.details
      }
    };
  }

  if (error instanceof ApplicationError || error instanceof DomainError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  if (error instanceof CliCommandError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error)
    }
  };
};

export const runCli = async (options: RunCliOptions): Promise<number> => {
  let storage: SQLiteStorageAdapter | undefined;
  let service: RouteLedgerService | undefined;

  const getStorage = (): SQLiteStorageAdapter => {
    storage ??= createStorage(options.projectRoot);
    return storage;
  };

  const getService = (): RouteLedgerService => {
    service ??= createService(getStorage());
    return service;
  };

  try {
    const response = await handleCommand({
      projectRoot: options.projectRoot,
      argv: options.argv,
      getStorage,
      getService
    });
    emitLine(options.stdout, response);
    return 0;
  } catch (error) {
    emitLine(options.stderr, toCliError(error));
    return 1;
  } finally {
    storage?.close();
  }
};
