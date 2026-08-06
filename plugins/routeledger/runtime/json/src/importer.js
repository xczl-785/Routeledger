import path from "node:path";
import { decodeProjectAggregateFromJsonDocuments } from "./codec.js";
import { ROUTELEDGER_JSON_ROOT } from "./constants.js";
import { readRouteLedgerJsonDocuments } from "./filesystem.js";
import { validateRouteLedgerJsonDocuments } from "./validator.js";
export class RouteLedgerJsonImportError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = "RouteLedgerJsonImportError";
        this.code = code;
        this.details = details;
    }
}
export const loadValidatedProjectAggregateFromJsonDirectory = async (inputRoot, options = {}) => {
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
    }
    catch (error) {
        throw new RouteLedgerJsonImportError("JSON_DECODE_FAILED", "JSON 文档集无法还原为 aggregate snapshot", {
            inputDir: path.join(absoluteInputRoot, ROUTELEDGER_JSON_ROOT),
            documentCount: documents.length,
            error: error instanceof Error ? error.message : String(error)
        });
    }
};
