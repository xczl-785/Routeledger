import {
  ROUTELEDGER_JSON_ROOT,
  ROUTELEDGER_SCHEMA_VERSION,
  SCHEMA_DOCUMENT_PATH
} from "./constants.js";
import type { RouteLedgerJsonDocument } from "./codec.js";

type SchemaManifestEntry = {
  kind: string;
  path_pattern: string;
};

// Human-readable canonical document manifest for the generated
// routeledger.schema.json. The machine-checked path whitelist that mirrors
// these entries lives in one place: ROUTELEDGER_CANONICAL_DOCUMENT_PATTERNS
// in filesystem.ts (exported as isCanonicalRouteLedgerJsonPath). Keep the
// kind set here in sync with that single source when adding a document type.
const schemaEntries: SchemaManifestEntry[] = [
  {
    kind: "project",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/project.json`
  },
  {
    kind: "current_ref",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/refs/current.json`
  },
  {
    kind: "version",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/versions/<id-prefix>/<id>.json`
  },
  {
    kind: "work_item",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/work_items/<id-prefix>/<id>.json`
  },
  {
    kind: "todo",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/todos/<id-prefix>/<id>.json`
  },
  {
    kind: "undo",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/undos/<id-prefix>/<id>.json`
  },
  {
    kind: "deferred_item",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/deferred_items/<id-prefix>/<id>.json`
  },
  {
    kind: "constraint",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/constraints/<id-prefix>/<id>.json`
  },
  {
    kind: "asset",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/assets/<id-prefix>/<id>.json`
  },
  {
    kind: "transition_event",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/events/<yyyy>/<mm>/<event_id>.json`
  },
  {
    kind: "pending_operation",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/pending_operations/<id-prefix>/<id>.json`
  },
  {
    kind: "approval_artifact",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/approval_artifacts/<id-prefix>/<id>.json`
  },
  {
    kind: "ordinary_write_receipt",
    path_pattern: `${ROUTELEDGER_JSON_ROOT}/ordinary_write_receipts/<id-prefix>/<id>.json`
  }
];

const stringifySchemaDocument = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2)}\n`;

export const buildRouteLedgerSchemaDocument = (): RouteLedgerJsonDocument => ({
  path: SCHEMA_DOCUMENT_PATH,
  content: stringifySchemaDocument({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://routeledger.dev/schema/routeledger.schema.json",
    title: "RouteLedger Canonical JSON Contract",
    description: "Public manifest for RouteLedger canonical JSON documents.",
    schema_version: ROUTELEDGER_SCHEMA_VERSION,
    document_root: ROUTELEDGER_JSON_ROOT,
    documents: schemaEntries
  })
});
