import fs from "node:fs/promises";
import path from "node:path";

import { DomainError } from "../domain/errors.js";
import type { Version } from "../domain/version.js";
import { validateAssetPath } from "../services/asset-service.js";

export interface CheckDocDriftExpectedPointer {
  kind: string;
  path: string;
  required?: boolean;
}

export interface CheckDocDriftInput {
  projectId: string;
  entryFiles: string[];
  expectedPointers?: CheckDocDriftExpectedPointer[];
}

export interface CheckDocDriftCheckedFile {
  path: string;
  bytes: number;
  matchedWarningCount: number;
}

export interface CheckDocDriftUnreadableFile {
  path: string;
  code: string;
  message: string;
}

export interface CheckDocDriftWarning {
  code: "STALE_CURRENT_VERSION" | "STALE_TRUTH_SOURCE" | "MISSING_EXPECTED_POINTER" | string;
  severity: "info" | "warning" | "blocking";
  file: string | null;
  summary: string;
  evidence?: string;
  expected?: string;
  actual?: string;
  line?: number;
}

export interface CheckDocDriftSuggestedTodo {
  title: string;
  reason: string;
  file?: string | null;
}

export interface CheckDocDriftResult {
  project: {
    id: string;
    name: string;
    currentVersionId: string | null;
  };
  routeTruth: {
    currentVersion: {
      id: string;
      title: string;
      state: Version["state"];
    } | null;
    openTodoCount: number;
    openUndoCount: number;
    pendingProposalCount: number;
    statusRiskCodes: string[];
  };
  checkedFiles: CheckDocDriftCheckedFile[];
  unreadableFiles: CheckDocDriftUnreadableFile[];
  warnings: CheckDocDriftWarning[];
  suggestedTodos: CheckDocDriftSuggestedTodo[];
  summaryText: string;
}

type CheckDocDriftRouteContext = {
  currentVersion: {
    id: string;
    title: string;
    state: Version["state"];
  } | null;
  openTodos: Array<{
    versionId: string;
  }>;
  openUndos: Array<{
    versionId: string;
    originVersionId: string;
    preferredResolutionVersionId: string;
  }>;
  pendingL3Proposals: Array<{
    id: string;
  }>;
  statusRisks: Array<{
    code: string;
  }>;
};

const CURRENT_POINTER_HINT_PATTERNS = [
  /\bcurrentVersion\b/i,
  /\bcurrent(?:\s+version)?\b/i,
  /当前版本/i,
  /主线/i
] as const;
const CANONICAL_CURRENT_POINTER_PATTERNS = [/\.routeledger[\\/]+refs[\\/]+current\.json/i] as const;
const TRUTH_SOURCE_HINT_PATTERNS = [/真源/i, /source of truth/i, /唯一真源/i] as const;
const CANONICAL_TRUTH_PATTERNS = [/\.routeledger/i, /canonical json/i] as const;

const includesAnyPattern = (value: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(value));

const findFirstMatchingLine = (
  content: string,
  predicate: (line: string) => boolean
): { line: number; evidence: string } | null => {
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (predicate(line)) {
      return {
        line: index + 1,
        evidence: line.trim()
      };
    }
  }

  return null;
};

const assertDocDriftEntryFilePath = (entryFile: string, index: number): void => {
  try {
    validateAssetPath("project_root", entryFile);
  } catch (error) {
    if (error instanceof DomainError && error.code === "INVALID_ASSET_PATH") {
      throw new DomainError("INVALID_ASSET_PATH", "entryFiles 必须是 project root 下的相对路径", {
        field: `entryFiles[${index}]`,
        path: entryFile
      });
    }

    throw error;
  }
};

const isPathInsideRoot = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
};

const resolveDocDriftEntryFilePath = async (
  projectRoot: string,
  entryFile: string
): Promise<string> => {
  const realProjectRoot = await fs.realpath(projectRoot);
  const resolvedPath = path.resolve(projectRoot, entryFile);
  const realResolvedPath = await fs.realpath(resolvedPath);

  if (!isPathInsideRoot(realProjectRoot, realResolvedPath)) {
    const error = new Error(
      `entry file resolves outside project root via symlink: ${entryFile}`
    ) as NodeJS.ErrnoException;
    error.code = "ENTRY_FILE_OUTSIDE_PROJECT_ROOT";
    throw error;
  }

  return realResolvedPath;
};

const findCurrentVersionDriftEvidence = (
  content: string,
  currentVersionId: string,
  currentVersionTitle: string
): { line: number; evidence: string } | null => {
  if (content.includes(currentVersionId) || content.includes(currentVersionTitle)) {
    return null;
  }

  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (!includesAnyPattern(line, CURRENT_POINTER_HINT_PATTERNS)) {
      continue;
    }

    if (includesAnyPattern(line, CANONICAL_CURRENT_POINTER_PATTERNS)) {
      continue;
    }

    return {
      line: index + 1,
      evidence: line.trim()
    };
  }

  return null;
};

const buildDocDriftSuggestedTodos = (
  warnings: CheckDocDriftWarning[]
): CheckDocDriftSuggestedTodo[] => {
  const seen = new Set<string>();
  const suggestedTodos: CheckDocDriftSuggestedTodo[] = [];

  for (const warning of warnings) {
    const key = `${warning.code}:${warning.file ?? "project"}:${warning.expected ?? ""}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    if (warning.code === "STALE_CURRENT_VERSION") {
      suggestedTodos.push({
        title: `同步 ${warning.file ?? "入口文档"} 的 current version 指针`,
        reason: warning.summary,
        file: warning.file
      });
      continue;
    }

    if (warning.code === "STALE_TRUTH_SOURCE") {
      suggestedTodos.push({
        title: `修正文档真源表述：${warning.file ?? "入口文档"}`,
        reason: warning.summary,
        file: warning.file
      });
      continue;
    }

    if (warning.code === "MISSING_EXPECTED_POINTER") {
      suggestedTodos.push({
        title: `补入口文档指针：${warning.expected ?? "expected pointer"}`,
        reason: warning.summary,
        file: warning.file
      });
    }
  }

  return suggestedTodos;
};

const buildDocDriftSummaryText = (options: {
  projectName: string;
  currentVersion: { id: string; title: string } | null;
  openTodoCount: number;
  openUndoCount: number;
  pendingProposalCount: number;
  checkedFileCount: number;
  unreadableFileCount: number;
  warningCount: number;
}): string => {
  const currentVersionText =
    options.currentVersion === null
      ? "No current version."
      : `Current version: ${options.currentVersion.title} (${options.currentVersion.id}).`;

  return [
    `Checked ${options.checkedFileCount} entry files for project ${options.projectName}.`,
    currentVersionText,
    `Route truth shows ${options.openTodoCount} open todos, ${options.openUndoCount} open undos, and ${options.pendingProposalCount} pending proposals on the current route.`,
    `Found ${options.warningCount} warnings and ${options.unreadableFileCount} unreadable files.`
  ].join(" ");
};

export const runDocDriftCheck = async (options: {
  projectRoot: string;
  project: {
    id: string;
    name: string;
    currentVersionId: string | null;
  };
  context: CheckDocDriftRouteContext;
  input: CheckDocDriftInput;
}): Promise<CheckDocDriftResult> => {
  const { projectRoot, project, context, input } = options;
  const currentVersion = context.currentVersion;
  const currentVersionId = currentVersion?.id ?? null;
  const currentVersionTitle = currentVersion?.title ?? null;
  const currentVersionOpenTodos =
    currentVersionId === null
      ? []
      : context.openTodos.filter((todo) => todo.versionId === currentVersionId);
  const currentVersionOpenUndos =
    currentVersionId === null
      ? []
      : context.openUndos.filter(
          (undo) =>
            undo.versionId === currentVersionId ||
            undo.originVersionId === currentVersionId ||
            undo.preferredResolutionVersionId === currentVersionId
        );
  const checkedFiles: CheckDocDriftCheckedFile[] = [];
  const unreadableFiles: CheckDocDriftUnreadableFile[] = [];
  const warnings: CheckDocDriftWarning[] = [];
  const readableFiles: Array<{ path: string; content: string }> = [];

  for (const [index, entryFile] of input.entryFiles.entries()) {
    assertDocDriftEntryFilePath(entryFile, index);

    try {
      const resolvedPath = await resolveDocDriftEntryFilePath(projectRoot, entryFile);
      const content = await fs.readFile(resolvedPath, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      let matchedWarningCount = 0;

      const currentVersionDriftEvidence =
        currentVersionId !== null && currentVersionTitle !== null
          ? findCurrentVersionDriftEvidence(content, currentVersionId, currentVersionTitle)
          : null;

      if (currentVersionDriftEvidence !== null) {
        warnings.push({
          code: "STALE_CURRENT_VERSION",
          severity: "warning",
          file: entryFile,
          summary: `${entryFile} 提到了 current 指针，但既没有包含当前 version id/title，也没有明确指向 .routeledger/refs/current.json。`,
          evidence: currentVersionDriftEvidence.evidence,
          expected: `${currentVersionTitle} (${currentVersionId})`,
          actual: "Document mentions current pointer without the live current version reference.",
          line: currentVersionDriftEvidence.line
        });
        matchedWarningCount += 1;
      }

      if (
        /sqlite/i.test(content) &&
        includesAnyPattern(content, TRUTH_SOURCE_HINT_PATTERNS) &&
        !includesAnyPattern(content, CANONICAL_TRUTH_PATTERNS)
      ) {
        const evidence =
          findFirstMatchingLine(
            content,
            (line) => /sqlite/i.test(line) && includesAnyPattern(line, TRUTH_SOURCE_HINT_PATTERNS)
          ) ??
          findFirstMatchingLine(content, (line) => /sqlite/i.test(line)) ??
          findFirstMatchingLine(content, (line) => includesAnyPattern(line, TRUTH_SOURCE_HINT_PATTERNS));
        warnings.push({
          code: "STALE_TRUTH_SOURCE",
          severity: "warning",
          file: entryFile,
          summary: `${entryFile} 把 SQLite 表述成真源，但没有明确 .routeledger canonical JSON 才是当前真源。`,
          evidence: evidence?.evidence,
          expected: ".routeledger canonical JSON is the runtime source of truth.",
          actual: "SQLite is presented as the source of truth.",
          line: evidence?.line
        });
        matchedWarningCount += 1;
      }

      checkedFiles.push({
        path: entryFile,
        bytes,
        matchedWarningCount
      });
      readableFiles.push({
        path: entryFile,
        content
      });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      unreadableFiles.push({
        path: entryFile,
        code: nodeError.code ?? "READ_FAILED",
        message: nodeError.message
      });
    }
  }

  for (const pointer of input.expectedPointers ?? []) {
    if (pointer.required === false) {
      continue;
    }

    const matched = readableFiles.some((file) => file.content.includes(pointer.path));

    if (!matched) {
      warnings.push({
        code: "MISSING_EXPECTED_POINTER",
        severity: "warning",
        file: null,
        summary: `入口文档没有指向期望路径 ${pointer.path}。`,
        expected: pointer.path,
        actual: "No checked entry file contains the expected pointer path."
      });
    }
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      currentVersionId: project.currentVersionId
    },
    routeTruth: {
      currentVersion:
        currentVersion === null
          ? null
          : {
              id: currentVersion.id,
              title: currentVersion.title,
              state: currentVersion.state
            },
      openTodoCount: currentVersionOpenTodos.length,
      openUndoCount: currentVersionOpenUndos.length,
      pendingProposalCount: context.pendingL3Proposals.length,
      statusRiskCodes: context.statusRisks.map((risk) => risk.code)
    },
    checkedFiles,
    unreadableFiles,
    warnings,
    suggestedTodos: buildDocDriftSuggestedTodos(warnings),
    summaryText: buildDocDriftSummaryText({
      projectName: project.name,
      currentVersion:
        currentVersion === null
          ? null
          : {
              id: currentVersion.id,
              title: currentVersion.title
            },
      openTodoCount: currentVersionOpenTodos.length,
      openUndoCount: currentVersionOpenUndos.length,
      pendingProposalCount: context.pendingL3Proposals.length,
      checkedFileCount: checkedFiles.length,
      unreadableFileCount: unreadableFiles.length,
      warningCount: warnings.length
    })
  };
};
