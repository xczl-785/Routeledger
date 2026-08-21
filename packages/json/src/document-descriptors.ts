import {
  CURRENT_REF_DOCUMENT_PATH,
  PROJECT_DOCUMENT_PATH,
  ROUTELEDGER_JSON_ROOT,
  SCHEMA_DOCUMENT_PATH
} from "./constants.js";

export interface RouteLedgerJsonDocument {
  path: string;
  content: string;
}

export interface CanonicalDocumentDescriptor {
  readonly id: string;
  readonly kind?: string;
  readonly pathPattern: string;
  readonly pathMatcher: RegExp;
  readonly namespacePrefix?: string;
  readonly requireSchemaVersion: boolean;
  readonly includeInSchemaManifest: boolean;
}

const exactPath = (value: string): RegExp =>
  new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

const entityDescriptor = (
  id: string,
  directory: string,
  pathPattern: string = `${ROUTELEDGER_JSON_ROOT}/${directory}/<id-prefix>/<id>.json`
): CanonicalDocumentDescriptor => ({
  id,
  kind: id,
  pathPattern,
  pathMatcher: new RegExp(`^\\.routeledger/${directory}/[^/]+/[^/]+\\.json$`),
  namespacePrefix: `${ROUTELEDGER_JSON_ROOT}/${directory}/`,
  requireSchemaVersion: true,
  includeInSchemaManifest: true
});

export const CANONICAL_DOCUMENT_DESCRIPTORS: readonly CanonicalDocumentDescriptor[] = [
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

export const matchCanonicalDocumentDescriptor = (
  documentPath: string
): CanonicalDocumentDescriptor | undefined =>
  CANONICAL_DOCUMENT_DESCRIPTORS.find((descriptor) =>
    descriptor.pathMatcher.test(documentPath)
  );

export const matchRouteLedgerDocumentContract = (
  documentPath: string
): CanonicalDocumentDescriptor | undefined =>
  CANONICAL_DOCUMENT_DESCRIPTORS.find(
    (descriptor) =>
      descriptor.pathMatcher.test(documentPath) ||
      (descriptor.namespacePrefix !== undefined &&
        documentPath.startsWith(descriptor.namespacePrefix))
  );
