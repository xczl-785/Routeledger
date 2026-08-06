import path from "node:path";

import type { ProjectAggregateSnapshot } from "@routeledger/core";

import {
  decodeProjectAggregateFromJsonDocuments,
  encodeProjectAggregateToJsonDocuments,
  type RouteLedgerJsonDocument
} from "./codec.js";
import { ROUTELEDGER_JSON_ROOT } from "./constants.js";
import { readRouteLedgerJsonDocuments } from "./filesystem.js";
import {
  type RouteLedgerJsonValidationIssue,
  validateRouteLedgerJsonDocuments
} from "./validator.js";

export interface RouteLedgerJsonMergeCheckResult {
  inputRoot: string;
  jsonRoot: string;
  documentCount: number;
  documents: RouteLedgerJsonDocument[];
  issues: RouteLedgerJsonValidationIssue[];
  valid: boolean;
  snapshot?: ProjectAggregateSnapshot;
}

const compareByString = (left: string, right: string): number => left.localeCompare(right, "en");

const createIssue = (
  code: string,
  message: string,
  extras: Omit<RouteLedgerJsonValidationIssue, "severity" | "code" | "message"> = {}
): RouteLedgerJsonValidationIssue => ({
  severity: "error",
  code,
  message,
  ...extras
});

const findDocumentContentMismatches = (
  leftDocuments: RouteLedgerJsonDocument[],
  rightDocuments: RouteLedgerJsonDocument[]
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

  return [...mismatches].sort(compareByString);
};

export const runRouteLedgerJsonMergeCheck = async (
  inputRoot: string
): Promise<RouteLedgerJsonMergeCheckResult> => {
  const absoluteInputRoot = path.resolve(inputRoot);
  const documents = await readRouteLedgerJsonDocuments(absoluteInputRoot);
  const validation = validateRouteLedgerJsonDocuments(documents);

  if (!validation.valid) {
    return {
      inputRoot: absoluteInputRoot,
      jsonRoot: path.join(absoluteInputRoot, ROUTELEDGER_JSON_ROOT),
      documentCount: documents.length,
      documents,
      issues: validation.issues,
      valid: false
    };
  }

  let snapshot: ProjectAggregateSnapshot | undefined;
  const issues = [...validation.issues];

  try {
    snapshot = decodeProjectAggregateFromJsonDocuments(documents);
  } catch (error) {
    issues.push(
      createIssue("JSON_DECODE_FAILED", "JSON 文档集无法还原为 aggregate snapshot", {
        details: {
          error: error instanceof Error ? error.message : String(error)
        }
      })
    );
  }

  if (snapshot !== undefined) {
    const canonicalDocuments = encodeProjectAggregateToJsonDocuments(snapshot);
    const mismatchedPaths = findDocumentContentMismatches(documents, canonicalDocuments);

    for (const mismatchedPath of mismatchedPaths) {
      issues.push(
        createIssue("JSON_CANONICAL_MISMATCH", "JSON 文档不是 canonical 形式", {
          path: mismatchedPath
        })
      );
    }
  }

  return {
    inputRoot: absoluteInputRoot,
    jsonRoot: path.join(absoluteInputRoot, ROUTELEDGER_JSON_ROOT),
    documentCount: documents.length,
    documents,
    issues,
    valid: !issues.some((issue) => issue.severity === "error"),
    snapshot
  };
};
