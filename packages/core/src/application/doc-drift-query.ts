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
  code:
    | "STALE_CURRENT_VERSION"
    | "STALE_TRUTH_SOURCE"
    | "MISSING_EXPECTED_POINTER"
    | "UNREADABLE_ENTRY_FILE"
    | string;
  severity: "info" | "warning" | "blocking";
  file: string | null;
  summary: string;
  evidence?: string;
  expected?: string;
  actual?: string;
  line?: number;
  assertionKind?: CheckDocDriftAssertionKind;
}

export interface CheckDocDriftSuggestedTodo {
  title: string;
  reason: string;
  file?: string | null;
}

export type CheckDocDriftAssertionKind =
  | "current_version_id"
  | "current_version_title"
  | "current_version_state";

export interface CheckDocDriftCheckedAssertion {
  kind: CheckDocDriftAssertionKind;
  file: string;
  status: "matched" | "mismatched" | "not_detected";
  expected: string | null;
  actual: string | null;
  evidence: string | null;
  line: number | null;
}

export interface CheckDocDriftCoverage {
  level: "none" | "partial";
  assertionKinds: CheckDocDriftAssertionKind[];
  checkedFileCount: number;
  recognizedAssertionCount: number;
  matchedAssertionCount: number;
  mismatchedAssertionCount: number;
  notDetectedAssertionCount: number;
  unrecognizedFileCount: number;
  limitations: string[];
  recommendedDeclarationTemplates: {
    "zh-CN": string[];
    en: string[];
  };
}

export interface CheckDocDriftResult {
  status: "completed" | "partial" | "not_completed";
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
  checkedAssertions: CheckDocDriftCheckedAssertion[];
  coverage: CheckDocDriftCoverage;
  warnings: CheckDocDriftWarning[];
  suggestedTodos: CheckDocDriftSuggestedTodo[];
  summaryText: string;
}

const HUMAN_ENTRY_DOCUMENT_CANDIDATES = [
  "README.md",
  "README.zh-CN.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "docs/index.md"
] as const;
const ROUTELEDGER_PROJECT_POINTER = ".routeledger/project.json";

export interface EntryDocumentCoverageResult {
  status: "covered" | "missing_routeledger_pointer" | "no_human_entry_document";
  entryFiles: Array<{
    path: string;
    containsRouteLedgerPointer: boolean;
  }>;
  warning: {
    code: "MISSING_ROUTELEDGER_POINTER" | "NO_HUMAN_ENTRY_DOCUMENT";
    severity: "info";
    summary: string;
  } | null;
  recommendedAction: {
    type: "create_or_update_entry_document";
    entryFile: string;
    requiredPointer: typeof ROUTELEDGER_PROJECT_POINTER;
    templateLocale: "zh-CN" | "en";
    template: string;
  } | null;
}

const entryDocumentTemplate = (locale: "zh-CN" | "en"): string =>
  locale === "zh-CN"
    ? [
        "## 项目路线",
        "",
        "本项目使用 RouteLedger 管理 Version 与工作项。",
        "",
        "- 权威路线数据：`.routeledger/project.json`",
        "- 当前 Version：通过 RouteLedger Mission Control 或 RouteLedger MCP 工具查看。"
      ].join("\n")
    : [
        "## Project route",
        "",
        "This project uses RouteLedger for Version and work tracking.",
        "",
        "- Canonical route data: `.routeledger/project.json`",
        "- Current Version: use RouteLedger Mission Control or the RouteLedger MCP tools."
      ].join("\n");

export const inspectEntryDocumentCoverage = async (options: {
  projectRoot: string;
  contentLocale: string;
}): Promise<EntryDocumentCoverageResult> => {
  const entryFiles: EntryDocumentCoverageResult["entryFiles"] = [];

  for (const candidate of HUMAN_ENTRY_DOCUMENT_CANDIDATES) {
    try {
      const content = await fs.readFile(path.join(options.projectRoot, candidate), "utf8");
      entryFiles.push({
        path: candidate,
        containsRouteLedgerPointer: content.includes(ROUTELEDGER_PROJECT_POINTER)
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        continue;
      }
    }
  }

  if (entryFiles.some((entry) => entry.containsRouteLedgerPointer)) {
    return {
      status: "covered",
      entryFiles,
      warning: null,
      recommendedAction: null
    };
  }

  const templateLocale = options.contentLocale.toLowerCase().startsWith("zh")
    ? "zh-CN"
    : "en";
  const hasEntryDocument = entryFiles.length > 0;
  return {
    status: hasEntryDocument
      ? "missing_routeledger_pointer"
      : "no_human_entry_document",
    entryFiles,
    warning: {
      code: hasEntryDocument
        ? "MISSING_ROUTELEDGER_POINTER"
        : "NO_HUMAN_ENTRY_DOCUMENT",
      severity: "info",
      summary: hasEntryDocument
        ? "Human entry documents exist but do not point to .routeledger/project.json."
        : "No common human entry document was found in the workspace."
    },
    recommendedAction: {
      type: "create_or_update_entry_document",
      entryFile: entryFiles[0]?.path ?? "README.md",
      requiredPointer: ROUTELEDGER_PROJECT_POINTER,
      templateLocale,
      template: entryDocumentTemplate(templateLocale)
    }
  };
};

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

const CURRENT_VERSION_ASSERTION_KINDS: CheckDocDriftAssertionKind[] = [
  "current_version_id",
  "current_version_title",
  "current_version_state"
];
const CURRENT_VERSION_DECLARATION_PATTERN =
  /^\s*(?:[-*]\s*)?(?:当前\s*(?:版本|version)|current\s+version)(?:\s+(id|标识|identifier|标题|title|状态|status|state))?\s*(?::|：|=|\bis\b|为)\s*(.+?)\s*$/i;
const CONTEXTUAL_CURRENT_STATE_PATTERN =
  /^\s*(?:[-*]\s*)?(?:当前\s*状态|current\s+(?:status|state))\s*(?::|：|=|\bis\b|为)\s*(.+?)\s*$/i;
const CURRENT_VERSION_CONTEXT_HEADING_PATTERN =
  /^\s*#{1,6}\s*(?:当前\s*(?:版本|version)|current\s+version)\s*$/i;
const CURRENT_POINTER_HINT_PATTERNS = [
  /\bcurrentVersion\b/i,
  /\bcurrent(?:\s+version)?\b/i,
  /当前\s*(?:版本|version)/i,
  /主线/i
] as const;
const CANONICAL_CURRENT_POINTER_PATTERNS = [
  /\.routeledger[\\/]+refs[\\/]+current\.json/i
] as const;
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

const normalizeAssertionValue = (value: string): string =>
  value
    .trim()
    .replace(/^still\s+/i, "")
    .replace(/[`*_]/g, "")
    .replace(/[.。]+$/u, "")
    .trim()
    .toLocaleLowerCase("en");

const isCanonicalPointerOnlyDeclaration = (value: string): boolean => {
  if (!includesAnyPattern(value, CANONICAL_CURRENT_POINTER_PATTERNS)) {
    return false;
  }

  return value
    .replace(/\bsee\b/gi, "")
    .replace(/参见|见/gu, "")
    .replace(/\.routeledger[\\/]+refs[\\/]+current\.json/gi, "")
    .replace(/[`*_\s:：=.,。;；()（）-]/gu, "")
    .length === 0;
};

const assertionKindFromQualifier = (
  qualifier: string | undefined
): CheckDocDriftAssertionKind | null => {
  if (qualifier === undefined) {
    return null;
  }

  if (/^(?:id|标识|identifier)$/i.test(qualifier)) {
    return "current_version_id";
  }
  if (/^(?:标题|title)$/i.test(qualifier)) {
    return "current_version_title";
  }
  if (/^(?:状态|status|state)$/i.test(qualifier)) {
    return "current_version_state";
  }
  return null;
};

const expectedAssertionValue = (
  kind: CheckDocDriftAssertionKind,
  currentVersion: { id: string; title: string; state: Version["state"] }
): string => {
  if (kind === "current_version_id") {
    return currentVersion.id;
  }
  if (kind === "current_version_title") {
    return currentVersion.title;
  }
  return currentVersion.state;
};

const assertionValueMatches = (
  kind: CheckDocDriftAssertionKind,
  actual: string,
  expected: string,
  explicitKind: boolean
): boolean => {
  const normalizedActual = normalizeAssertionValue(actual);
  const normalizedExpected = normalizeAssertionValue(expected);
  if (explicitKind) {
    return normalizedActual === normalizedExpected;
  }

  if (kind === "current_version_title") {
    return (
      normalizedActual === normalizedExpected ||
      (normalizedActual.startsWith(`${normalizedExpected} (`) &&
        normalizedActual.endsWith(")"))
    );
  }

  if (kind === "current_version_id") {
    const index = normalizedActual.indexOf(normalizedExpected);
    if (index === -1) {
      return false;
    }
    const before = normalizedActual[index - 1] ?? "";
    const after = normalizedActual[index + normalizedExpected.length] ?? "";
    return !/[a-z0-9-]/u.test(before) && !/[a-z0-9-]/u.test(after);
  }

  const tokens = normalizedActual
    .split(/[^a-z]+/u)
    .filter((token) => token.length > 0);
  const stateIndex = tokens.indexOf(normalizedExpected);
  if (stateIndex === -1) {
    return false;
  }
  const precedingTokens = tokens.slice(0, stateIndex);
  const hasEnglishNegation = precedingTokens.some((token) =>
    ["no", "non", "not", "without"].includes(token)
  );
  const hasContractedNegation = /\bisn['’]?t\b/u.test(normalizedActual);
  const hasChineseNegation = /[不非]/u.test(normalizedActual.slice(0, normalizedActual.indexOf(normalizedExpected)));
  return !hasEnglishNegation && !hasContractedNegation && !hasChineseNegation;
};

const assertionValueMentionsState = (actual: string, expected: string): boolean =>
  normalizeAssertionValue(actual)
    .split(/[^a-z]+/u)
    .filter((token) => token.length > 0)
    .includes(normalizeAssertionValue(expected));

const findCurrentVersionAssertions = (
  file: string,
  content: string,
  currentVersion: { id: string; title: string; state: Version["state"] }
): CheckDocDriftCheckedAssertion[] => {
  const lines = content.split(/\r?\n/);
  const assertions: CheckDocDriftCheckedAssertion[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const declarationMatch = line.match(CURRENT_VERSION_DECLARATION_PATTERN);
    const contextualStateMatch = line.match(CONTEXTUAL_CURRENT_STATE_PATTERN);
    const hasNearbyCurrentVersionContext = lines
      .slice(Math.max(0, index - 3), index)
      .some(
        (candidate) =>
          CURRENT_VERSION_DECLARATION_PATTERN.test(candidate) ||
          CURRENT_VERSION_CONTEXT_HEADING_PATTERN.test(candidate)
      );
    if (
      declarationMatch === null &&
      (contextualStateMatch === null || !hasNearbyCurrentVersionContext)
    ) {
      continue;
    }
    const qualifierKind =
      declarationMatch === null
        ? "current_version_state"
        : assertionKindFromQualifier(declarationMatch[1]);
    const actual = (
      declarationMatch === null ? contextualStateMatch?.[1] : declarationMatch[2]
    )?.trim() ?? "";
    if (isCanonicalPointerOnlyDeclaration(actual)) {
      continue;
    }
    const candidateKinds =
      qualifierKind === null
        ? CURRENT_VERSION_ASSERTION_KINDS.filter((kind) =>
            assertionValueMatches(
              kind,
              actual,
              expectedAssertionValue(kind, currentVersion),
              false
            )
          )
        : [qualifierKind];
    const kinds =
      candidateKinds.length > 0
        ? candidateKinds
        : qualifierKind === null &&
            assertionValueMentionsState(
              actual,
              expectedAssertionValue("current_version_state", currentVersion)
            )
          ? (["current_version_state"] as CheckDocDriftAssertionKind[])
          : (["current_version_title"] as CheckDocDriftAssertionKind[]);

    for (const kind of kinds) {
      const expected = expectedAssertionValue(kind, currentVersion);
      assertions.push({
        kind,
        file,
        status: assertionValueMatches(kind, actual, expected, qualifierKind !== null)
          ? "matched"
          : "mismatched",
        expected,
        actual,
        evidence: line.trim(),
        line: index + 1
      });
    }
  }

  for (const kind of CURRENT_VERSION_ASSERTION_KINDS) {
    if (!assertions.some((assertion) => assertion.kind === kind)) {
      assertions.push({
        kind,
        file,
        status: "not_detected",
        expected: expectedAssertionValue(kind, currentVersion),
        actual: null,
        evidence: null,
        line: null
      });
    }
  }

  return assertions;
};

const buildDocDriftSuggestedTodos = (
  warnings: CheckDocDriftWarning[]
): CheckDocDriftSuggestedTodo[] => {
  const suggestionsByKey = new Map<string, CheckDocDriftSuggestedTodo>();
  const suggestedTodos: CheckDocDriftSuggestedTodo[] = [];

  for (const warning of warnings) {
    if (warning.code === "STALE_CURRENT_VERSION") {
      const key = `${warning.code}:${warning.file ?? "project"}`;
      const existing = suggestionsByKey.get(key);
      if (existing !== undefined) {
        if (!existing.reason.includes(warning.summary)) {
          existing.reason = `${existing.reason}\n${warning.summary}`;
        }
        continue;
      }
      const suggestion = {
        title: `同步 ${warning.file ?? "入口文档"} 的 current version 指针`,
        reason: warning.summary,
        file: warning.file
      };
      suggestionsByKey.set(key, suggestion);
      suggestedTodos.push(suggestion);
      continue;
    }

    if (warning.code === "STALE_TRUTH_SOURCE") {
      const key = `${warning.code}:${warning.file ?? "project"}`;
      if (suggestionsByKey.has(key)) {
        continue;
      }
      const suggestion = {
        title: `修正文档真源表述：${warning.file ?? "入口文档"}`,
        reason: warning.summary,
        file: warning.file
      };
      suggestionsByKey.set(key, suggestion);
      suggestedTodos.push(suggestion);
      continue;
    }

    if (warning.code === "MISSING_EXPECTED_POINTER") {
      const key = `${warning.code}:${warning.expected ?? "expected pointer"}`;
      if (suggestionsByKey.has(key)) {
        continue;
      }
      const suggestion = {
        title: `补入口文档指针：${warning.expected ?? "expected pointer"}`,
        reason: warning.summary,
        file: warning.file
      };
      suggestionsByKey.set(key, suggestion);
      suggestedTodos.push(suggestion);
    }
  }

  return suggestedTodos;
};

const buildDocDriftSummaryText = (options: {
  status: CheckDocDriftResult["status"];
  coverageLevel: CheckDocDriftCoverage["level"];
  projectName: string;
  currentVersion: { id: string; title: string } | null;
  openTodoCount: number;
  openUndoCount: number;
  pendingProposalCount: number;
  checkedFileCount: number;
  unreadableFileCount: number;
  warningCount: number;
  recognizedAssertionCount: number;
  notDetectedAssertionCount: number;
}): string => {
  const currentVersionText =
    options.currentVersion === null
      ? "No current version."
      : `Current version: ${options.currentVersion.title} (${options.currentVersion.id}).`;

  return [
    `Check status: ${options.status}.`,
    `Checked ${options.checkedFileCount} entry files for project ${options.projectName}.`,
    currentVersionText,
    `Route truth shows ${options.openTodoCount} open todos, ${options.openUndoCount} open undos, and ${options.pendingProposalCount} pending proposals on the current route.`,
    `Found ${options.warningCount} warnings and ${options.unreadableFileCount} unreadable files.`,
    `Coverage is ${options.coverageLevel}: recognized ${options.recognizedAssertionCount} explicit current-Version assertions; ${options.notDetectedAssertionCount} assertion fields were not detected.`
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
  const checkedAssertions: CheckDocDriftCheckedAssertion[] = [];
  const warnings: CheckDocDriftWarning[] = [];
  const readableFiles: Array<{ path: string; content: string }> = [];

  for (const [index, entryFile] of input.entryFiles.entries()) {
    assertDocDriftEntryFilePath(entryFile, index);

    try {
      const resolvedPath = await resolveDocDriftEntryFilePath(projectRoot, entryFile);
      const content = await fs.readFile(resolvedPath, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      let matchedWarningCount = 0;

      if (currentVersion !== null) {
        const fileAssertions = findCurrentVersionAssertions(
          entryFile,
          content,
          currentVersion
        );
        checkedAssertions.push(...fileAssertions);

        for (const assertion of fileAssertions.filter(
          (candidate) => candidate.status === "mismatched"
        )) {
          warnings.push({
            code: "STALE_CURRENT_VERSION",
            severity: "warning",
            file: entryFile,
            summary: `${entryFile} 的 ${assertion.kind} 声明与 RouteLedger 当前事实不一致。`,
            evidence: assertion.evidence ?? undefined,
            expected: assertion.expected ?? undefined,
            actual: assertion.actual ?? undefined,
            line: assertion.line ?? undefined,
            assertionKind: assertion.kind
          });
          matchedWarningCount += 1;
        }

        if (
          !fileAssertions.some((assertion) => assertion.status !== "not_detected") &&
          !content.includes(currentVersion.id) &&
          !content.includes(currentVersion.title)
        ) {
          const broadEvidence = findFirstMatchingLine(
            content,
            (line) =>
              includesAnyPattern(line, CURRENT_POINTER_HINT_PATTERNS) &&
              !includesAnyPattern(line, CANONICAL_CURRENT_POINTER_PATTERNS)
          );
          if (broadEvidence !== null) {
            warnings.push({
              code: "STALE_CURRENT_VERSION",
              severity: "warning",
              file: entryFile,
              summary: `${entryFile} 提到了 current 路线，但没有可核对的当前 Version ID、标题或状态声明。`,
              evidence: broadEvidence.evidence,
              expected: `${currentVersion.title} (${currentVersion.id}, ${currentVersion.state})`,
              actual: "Document mentions the current route without an explicit comparable current-Version declaration.",
              line: broadEvidence.line
            });
            matchedWarningCount += 1;
          }
        }
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
      warnings.push({
        code: "UNREADABLE_ENTRY_FILE",
        severity: "blocking",
        file: entryFile,
        summary: `${entryFile} 无法读取，未完成该入口文档的漂移检查。`,
        expected: "A readable entry file.",
        actual: `${nodeError.code ?? "READ_FAILED"}: ${nodeError.message}`
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

  const recognizedAssertions = checkedAssertions.filter(
    (assertion) => assertion.status !== "not_detected"
  );
  const matchedAssertions = checkedAssertions.filter(
    (assertion) => assertion.status === "matched"
  );
  const mismatchedAssertions = checkedAssertions.filter(
    (assertion) => assertion.status === "mismatched"
  );
  const notDetectedAssertions = checkedAssertions.filter(
    (assertion) => assertion.status === "not_detected"
  );
  const status: CheckDocDriftResult["status"] =
    checkedFiles.length === 0
      ? "not_completed"
      : unreadableFiles.length > 0
        ? "partial"
        : "completed";
  const coverage: CheckDocDriftCoverage = {
    level: checkedFiles.length === 0 ? "none" : "partial",
    assertionKinds: CURRENT_VERSION_ASSERTION_KINDS,
    checkedFileCount: checkedFiles.length,
    recognizedAssertionCount: recognizedAssertions.length,
    matchedAssertionCount: matchedAssertions.length,
    mismatchedAssertionCount: mismatchedAssertions.length,
    notDetectedAssertionCount: notDetectedAssertions.length,
    unrecognizedFileCount: checkedFiles.filter(
      (file) =>
        !recognizedAssertions.some((assertion) => assertion.file === file.path)
    ).length,
    limitations: [
      "Explicit Chinese or English current-Version declarations are compared; short current-state aliases require nearby current-Version context.",
      "A partial result does not prove that every route statement in the checked documents is current."
    ],
    recommendedDeclarationTemplates:
      currentVersion === null
        ? { "zh-CN": [], en: [] }
        : {
            "zh-CN": [
              `当前 Version 标题：${currentVersion.title}`,
              `当前 Version ID：${currentVersion.id}`,
              `当前 Version 状态：${currentVersion.state}`
            ],
            en: [
              `Current Version Title: ${currentVersion.title}`,
              `Current Version ID: ${currentVersion.id}`,
              `Current Version State: ${currentVersion.state}`
            ]
          }
  };

  return {
    status,
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
    checkedAssertions,
    coverage,
    warnings,
    suggestedTodos: buildDocDriftSuggestedTodos(warnings),
    summaryText: buildDocDriftSummaryText({
      status,
      coverageLevel: coverage.level,
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
      warningCount: warnings.length,
      recognizedAssertionCount: coverage.recognizedAssertionCount,
      notDetectedAssertionCount: coverage.notDetectedAssertionCount
    })
  };
};
