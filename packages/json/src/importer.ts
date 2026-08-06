import path from "node:path";

import type { ProjectAggregateSnapshot } from "@routeledger/core";

import { decodeProjectAggregateFromJsonDocuments, type RouteLedgerJsonDocument } from "./codec.js";
import { ROUTELEDGER_JSON_ROOT } from "./constants.js";
import { readRouteLedgerJsonDocuments, type RouteLedgerJsonReadOptions } from "./filesystem.js";
import {
  validateRouteLedgerJsonDocuments,
  type RouteLedgerJsonValidationIssue
} from "./validator.js";

export type RouteLedgerJsonImportErrorCode =
  | "JSON_VALIDATION_FAILED"
  | "JSON_DECODE_FAILED";

export class RouteLedgerJsonImportError extends Error {
  readonly code: RouteLedgerJsonImportErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: RouteLedgerJsonImportErrorCode, message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "RouteLedgerJsonImportError";
    this.code = code;
    this.details = details;
  }
}

export interface LoadValidatedProjectAggregateFromJsonDirectoryResult {
  inputRoot: string;
  jsonRoot: string;
  documentCount: number;
  documents: RouteLedgerJsonDocument[];
  issues: RouteLedgerJsonValidationIssue[];
  snapshot: ProjectAggregateSnapshot;
}

export const loadValidatedProjectAggregateFromJsonDirectory = async (
  inputRoot: string,
  options: RouteLedgerJsonReadOptions = {}
): Promise<LoadValidatedProjectAggregateFromJsonDirectoryResult> => {
  const absoluteInputRoot = path.resolve(inputRoot);
  const documents = await readRouteLedgerJsonDocuments(absoluteInputRoot, options);
  const validation = validateRouteLedgerJsonDocuments(documents);

  if (!validation.valid) {
    throw new RouteLedgerJsonImportError("JSON_VALIDATION_FAILED", "JSON validate 发现错误", {
      inputDir: path.join(absoluteInputRoot, ROUTELEDGER_JSON_ROOT),
      documentCount: documents.length,
      valid: validation.valid,
      issues: validation.issues
    });
  }

  try {
    return {
      inputRoot: absoluteInputRoot,
      jsonRoot: path.join(absoluteInputRoot, ROUTELEDGER_JSON_ROOT),
      documentCount: documents.length,
      documents,
      issues: validation.issues,
      snapshot: decodeProjectAggregateFromJsonDocuments(documents)
    };
  } catch (error) {
    throw new RouteLedgerJsonImportError(
      "JSON_DECODE_FAILED",
      "JSON 文档集无法还原为 aggregate snapshot",
      {
        inputDir: path.join(absoluteInputRoot, ROUTELEDGER_JSON_ROOT),
        documentCount: documents.length,
        error: error instanceof Error ? error.message : String(error)
      }
    );
  }
};
