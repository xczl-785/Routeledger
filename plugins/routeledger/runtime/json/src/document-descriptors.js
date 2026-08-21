import { CURRENT_REF_DOCUMENT_PATH, PROJECT_DOCUMENT_PATH, ROUTELEDGER_JSON_ROOT, SCHEMA_DOCUMENT_PATH } from "./constants.js";
const exactPath = (value) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
const entityDescriptor = (id, directory, pathPattern = `${ROUTELEDGER_JSON_ROOT}/${directory}/<id-prefix>/<id>.json`) => ({
    id,
    kind: id,
    pathPattern,
    pathMatcher: new RegExp(`^\\.routeledger/${directory}/[^/]+/[^/]+\\.json$`),
    namespacePrefix: `${ROUTELEDGER_JSON_ROOT}/${directory}/`,
    requireSchemaVersion: true,
    includeInSchemaManifest: true
});
export const CANONICAL_DOCUMENT_DESCRIPTORS = [
    {
        id: "project",
        kind: "project",
        pathPattern: PROJECT_DOCUMENT_PATH,
        pathMatcher: exactPath(PROJECT_DOCUMENT_PATH),
        requireSchemaVersion: true,
        includeInSchemaManifest: true
    },
    {
        id: "current_ref",
        kind: "current_ref",
        pathPattern: CURRENT_REF_DOCUMENT_PATH,
        pathMatcher: exactPath(CURRENT_REF_DOCUMENT_PATH),
        requireSchemaVersion: true,
        includeInSchemaManifest: true
    },
    {
        id: "schema",
        pathPattern: SCHEMA_DOCUMENT_PATH,
        pathMatcher: exactPath(SCHEMA_DOCUMENT_PATH),
        requireSchemaVersion: true,
        includeInSchemaManifest: false
    },
    entityDescriptor("version", "versions"),
    entityDescriptor("work_item", "work_items"),
    entityDescriptor("todo", "todos"),
    entityDescriptor("undo", "undos"),
    entityDescriptor("deferred_item", "deferred_items"),
    entityDescriptor("constraint", "constraints"),
    entityDescriptor("asset", "assets"),
    {
        id: "transition_event",
        kind: "transition_event",
        pathPattern: `${ROUTELEDGER_JSON_ROOT}/events/<yyyy>/<mm>/<event_id>.json`,
        pathMatcher: /^\.routeledger\/events\/\d{4}\/\d{2}\/[^/]+\.json$/,
        namespacePrefix: `${ROUTELEDGER_JSON_ROOT}/events/`,
        requireSchemaVersion: true,
        includeInSchemaManifest: true
    },
    entityDescriptor("pending_operation", "pending_operations"),
    entityDescriptor("approval_artifact", "approval_artifacts"),
    entityDescriptor("ordinary_write_receipt", "ordinary_write_receipts")
];
export const matchCanonicalDocumentDescriptor = (documentPath) => CANONICAL_DOCUMENT_DESCRIPTORS.find((descriptor) => descriptor.pathMatcher.test(documentPath));
export const matchRouteLedgerDocumentContract = (documentPath) => CANONICAL_DOCUMENT_DESCRIPTORS.find((descriptor) => descriptor.pathMatcher.test(documentPath) ||
    (descriptor.namespacePrefix !== undefined &&
        documentPath.startsWith(descriptor.namespacePrefix)));
const getIdPrefix = (id) => id.slice(0, 2).padEnd(2, "_");
export const buildCanonicalIdDocumentPath = (descriptorId, entityId) => {
    const descriptor = CANONICAL_DOCUMENT_DESCRIPTORS.find((candidate) => candidate.id === descriptorId);
    if (descriptor?.namespacePrefix === undefined) {
        throw new Error(`Canonical document descriptor has no ID namespace: ${descriptorId}`);
    }
    return `${descriptor.namespacePrefix}${getIdPrefix(entityId)}/${entityId}.json`;
};
export const buildTransitionEventDocumentPath = (event) => {
    const match = /^(\d{4})-(\d{2})/.exec(event.createdAt);
    if (match === null)
        return undefined;
    const [, year, month] = match;
    const descriptor = CANONICAL_DOCUMENT_DESCRIPTORS.find((candidate) => candidate.id === "transition_event");
    return `${descriptor.namespacePrefix}${year}/${month}/${event.id}.json`;
};
