import { ROUTELEDGER_JSON_ROOT, ROUTELEDGER_SCHEMA_VERSION, SCHEMA_DOCUMENT_PATH } from "./constants.js";
import { CANONICAL_DOCUMENT_DESCRIPTORS } from "./document-descriptors.js";
// Human-readable canonical document manifest for the generated
// routeledger.schema.json. Validation and filesystem matching project the same
// descriptors through their respective compatibility rules.
const schemaEntries = CANONICAL_DOCUMENT_DESCRIPTORS
    .filter((descriptor) => descriptor.includeInSchemaManifest)
    .map((descriptor) => ({
    kind: descriptor.kind,
    path_pattern: descriptor.pathPattern
}));
const stringifySchemaDocument = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const buildRouteLedgerSchemaDocument = () => ({
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
