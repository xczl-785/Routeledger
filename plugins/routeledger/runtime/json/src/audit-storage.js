import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
export const AUDIT_LAYOUT_DOCUMENT_PATH = ".routeledger/audit/layout.json";
export const AUDIT_OPERATION_DIRECTORY = "operations";
export const AUDIT_PACK_DIRECTORY = "audit_packs";
const canonicalJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
const compactPhysicalJson = (value) => `${JSON.stringify(value)}\n`;
const digestPayload = (value) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const auditFileStem = (id) => {
    const readable = id.replace(/[^A-Za-z0-9._-]/gu, "_");
    return readable === id
        ? id
        : `${readable}-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
};
export const auditPackDocumentPath = (versionId) => `.routeledger/${AUDIT_PACK_DIRECTORY}/${auditFileStem(versionId)}.json`;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const operationIdFromDocument = (document) => {
    if (!document.path.startsWith(".routeledger/events/") &&
        !document.path.startsWith(".routeledger/ordinary_write_receipts/")) {
        return null;
    }
    let payload;
    try {
        payload = JSON.parse(document.content);
    }
    catch {
        return null;
    }
    if (isRecord(payload) && typeof payload.operation_id === "string") {
        return payload.operation_id;
    }
    const visit = (value) => {
        if (Array.isArray(value)) {
            for (const entry of value) {
                const found = visit(entry);
                if (found !== null)
                    return found;
            }
            return null;
        }
        if (!isRecord(value))
            return null;
        if (typeof value.operation_id === "string")
            return value.operation_id;
        if (typeof value.operationId === "string")
            return value.operationId;
        for (const entry of Object.values(value)) {
            const found = visit(entry);
            if (found !== null)
                return found;
        }
        return null;
    };
    return visit(payload);
};
const createEnvelope = (operationId, documents) => {
    const payload = {
        format_version: 1,
        kind: "routeledger_operation_envelope",
        operation_id: operationId,
        documents: documents
            .map((document) => ({ path: document.path, payload: JSON.parse(document.content) }))
            .sort((left, right) => left.path.localeCompare(right.path, "en"))
    };
    const envelope = { ...payload, digest: digestPayload(payload) };
    return {
        path: `.routeledger/${AUDIT_OPERATION_DIRECTORY}/${auditFileStem(operationId)}.json`,
        content: compactPhysicalJson(envelope)
    };
};
export const buildAuditPhysicalDocuments = (documents, preservedPacks = []) => {
    const grouped = new Map();
    const loose = [];
    const packedPaths = new Set(preservedPacks.flatMap((pack) => pack.logicalDocuments.map((document) => document.path)));
    const documentByPath = new Map(documents.map((document) => [document.path, document]));
    for (const pack of preservedPacks) {
        for (const packedDocument of pack.logicalDocuments) {
            const current = documentByPath.get(packedDocument.path);
            if (current === undefined || current.content !== packedDocument.content) {
                throw new Error(`packed audit document is immutable: ${packedDocument.path}`);
            }
        }
    }
    for (const document of documents) {
        if (packedPaths.has(document.path))
            continue;
        const operationId = operationIdFromDocument(document);
        if (operationId === null) {
            loose.push(document);
            continue;
        }
        const operationDocuments = grouped.get(operationId) ?? [];
        operationDocuments.push(document);
        grouped.set(operationId, operationDocuments);
    }
    const layout = {
        format_version: 1,
        operation_envelopes: true
    };
    loose.push({ path: AUDIT_LAYOUT_DOCUMENT_PATH, content: canonicalJson(layout) });
    for (const [operationId, operationDocuments] of [...grouped].sort(([left], [right]) => left.localeCompare(right, "en"))) {
        loose.push(createEnvelope(operationId, operationDocuments));
    }
    loose.push(...preservedPacks.map((pack) => pack.physicalDocument));
    return {
        documents: loose.sort((left, right) => left.path.localeCompare(right.path, "en")),
        operationEnvelopeCount: grouped.size
    };
};
const embeddedDocuments = (documents) => documents
    .map((document) => ({ path: document.path, payload: JSON.parse(document.content) }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
export const createClosedVersionAuditPack = (documents, versionId, closedAt) => {
    const parsed = documents.map((document) => ({
        document,
        payload: JSON.parse(document.content)
    }));
    const relatedIds = new Set([versionId]);
    const pendingIds = new Set();
    for (const { payload } of parsed) {
        if (!isRecord(payload) || typeof payload.id !== "string")
            continue;
        if (payload.kind === "pending_operation" && payload.target_id === versionId) {
            pendingIds.add(payload.id);
            relatedIds.add(payload.id);
            continue;
        }
        if (payload.version_id === versionId ||
            payload.origin_version_id === versionId ||
            payload.target_review_version_id === versionId ||
            (isRecord(payload.scope) && payload.scope.version_id === versionId)) {
            relatedIds.add(payload.id);
        }
    }
    const operationIds = new Set();
    for (const { payload } of parsed) {
        if (isRecord(payload) && payload.kind === "transition_event" &&
            typeof payload.operation_id === "string" && typeof payload.target_id === "string" &&
            relatedIds.has(payload.target_id)) {
            operationIds.add(payload.operation_id);
        }
    }
    const selected = parsed.filter(({ document, payload }) => {
        if (!isRecord(payload))
            return false;
        if (document.path.startsWith(".routeledger/events/")) {
            return typeof payload.operation_id === "string" && operationIds.has(payload.operation_id);
        }
        if (document.path.startsWith(".routeledger/ordinary_write_receipts/")) {
            const operationId = operationIdFromDocument(document);
            return operationId !== null && operationIds.has(operationId);
        }
        if (document.path.startsWith(".routeledger/pending_operations/")) {
            return typeof payload.id === "string" && pendingIds.has(payload.id);
        }
        if (document.path.startsWith(".routeledger/approval_artifacts/")) {
            return (typeof payload.pending_operation_id === "string" &&
                pendingIds.has(payload.pending_operation_id)) || payload.target_id === versionId;
        }
        return false;
    }).map(({ document }) => document);
    const packPayload = {
        format_version: 1,
        kind: "routeledger_closed_version_audit_pack",
        version_id: versionId,
        closed_at: closedAt,
        documents: embeddedDocuments(selected)
    };
    const pack = { ...packPayload, digest: digestPayload(packPayload) };
    return {
        physicalDocument: {
            path: auditPackDocumentPath(versionId),
            content: compactPhysicalJson(pack)
        },
        logicalDocuments: selected.sort((left, right) => left.path.localeCompare(right.path, "en"))
    };
};
const readJsonFiles = async (directory) => {
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const paths = [];
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory())
                paths.push(...(await readJsonFiles(entryPath)));
            else if (entry.isFile() && entry.name.endsWith(".json"))
                paths.push(entryPath);
        }
        return paths.sort((left, right) => left.localeCompare(right, "en"));
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return [];
        throw error;
    }
};
export const readOperationEnvelopeDocuments = async (absoluteJsonRoot, invalid) => {
    const files = await readJsonFiles(path.join(absoluteJsonRoot, AUDIT_OPERATION_DIRECTORY));
    const documents = [];
    for (const file of files) {
        let envelope;
        try {
            envelope = JSON.parse(await fs.readFile(file, "utf8"));
        }
        catch (error) {
            throw invalid("operation envelope is not valid JSON", { file, cause: String(error) });
        }
        if (!isRecord(envelope) || envelope.kind !== "routeledger_operation_envelope" ||
            envelope.format_version !== 1 || typeof envelope.operation_id !== "string" ||
            !Array.isArray(envelope.documents) || typeof envelope.digest !== "string") {
            throw invalid("operation envelope shape is invalid", { file });
        }
        const { digest, ...payload } = envelope;
        if (digest !== digestPayload(payload)) {
            throw invalid("operation envelope digest does not match its contents", { file });
        }
        for (const embedded of envelope.documents) {
            if (!isRecord(embedded) || typeof embedded.path !== "string" || !("payload" in embedded)) {
                throw invalid("operation envelope contains an invalid document", { file });
            }
            documents.push({ path: embedded.path, content: canonicalJson(embedded.payload) });
        }
    }
    return documents;
};
export const readAuditPacks = async (absoluteJsonRoot, invalid) => {
    const packRoot = path.join(absoluteJsonRoot, AUDIT_PACK_DIRECTORY);
    const files = await readJsonFiles(packRoot);
    const packs = [];
    for (const file of files) {
        let pack;
        const rawContent = await fs.readFile(file, "utf8");
        try {
            pack = JSON.parse(rawContent);
        }
        catch (error) {
            throw invalid("audit pack is not valid JSON", { file, cause: String(error) });
        }
        if (!isRecord(pack) || pack.kind !== "routeledger_closed_version_audit_pack" ||
            pack.format_version !== 1 || typeof pack.version_id !== "string" ||
            typeof pack.closed_at !== "string" || !Array.isArray(pack.documents) ||
            typeof pack.digest !== "string") {
            throw invalid("audit pack shape is invalid", { file });
        }
        const { digest, ...payload } = pack;
        if (digest !== digestPayload(payload)) {
            throw invalid("audit pack digest does not match its contents", { file });
        }
        const logicalDocuments = [];
        for (const embedded of pack.documents) {
            if (!isRecord(embedded) || typeof embedded.path !== "string" || !("payload" in embedded)) {
                throw invalid("audit pack contains an invalid document", { file });
            }
            logicalDocuments.push({ path: embedded.path, content: canonicalJson(embedded.payload) });
        }
        packs.push({
            physicalDocument: {
                path: `.routeledger/${AUDIT_PACK_DIRECTORY}/${path.relative(packRoot, file).replaceAll("\\", "/")}`,
                content: rawContent
            },
            logicalDocuments
        });
    }
    return packs;
};
export const auditLayoutExists = async (absoluteJsonRoot) => {
    try {
        await fs.access(path.join(absoluteJsonRoot, "audit", "layout.json"));
        return true;
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return false;
        throw error;
    }
};
