import path from "node:path";
import { decodeProjectAggregateFromJsonDocuments, encodeProjectAggregateToJsonDocuments } from "./codec.js";
import { ROUTELEDGER_JSON_ROOT } from "./constants.js";
import { readRouteLedgerJsonDocuments } from "./filesystem.js";
import { validateRouteLedgerJsonDocuments } from "./validator.js";
const compareByString = (left, right) => left.localeCompare(right, "en");
const createIssue = (code, message, extras = {}) => ({
    severity: "error",
    code,
    message,
    ...extras
});
const findDocumentContentMismatches = (leftDocuments, rightDocuments) => {
    const rightByPath = new Map(rightDocuments.map((document) => [document.path, document.content]));
    const leftPaths = new Set(leftDocuments.map((document) => document.path));
    const rightPaths = new Set(rightDocuments.map((document) => document.path));
    const mismatches = new Set();
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
export const runRouteLedgerJsonMergeCheck = async (inputRoot) => {
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
    let snapshot;
    const issues = [...validation.issues];
    try {
        snapshot = decodeProjectAggregateFromJsonDocuments(documents);
    }
    catch (error) {
        issues.push(createIssue("JSON_DECODE_FAILED", "JSON 文档集无法还原为 aggregate snapshot", {
            details: {
                error: error instanceof Error ? error.message : String(error)
            }
        }));
    }
    if (snapshot !== undefined) {
        const canonicalDocuments = encodeProjectAggregateToJsonDocuments(snapshot);
        const mismatchedPaths = findDocumentContentMismatches(documents, canonicalDocuments);
        for (const mismatchedPath of mismatchedPaths) {
            issues.push(createIssue("JSON_CANONICAL_MISMATCH", "JSON 文档不是 canonical 形式", {
                path: mismatchedPath
            }));
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
