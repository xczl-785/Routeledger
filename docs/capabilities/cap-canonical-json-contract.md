# cap-canonical-json-contract

## Scope

This capability defines the canonical JSON document set used to represent a
RouteLedger project.

## Current rules

1. The encoder and validator own the accepted document paths, schemas, and
   cross-document relations. `project.json` and `refs/current.json` must agree
   with the aggregate they describe.
2. Replacement is staged and recoverable. Interrupted replacement is examined
   before read or write operations; non-canonical `db/`, `views/`, and runtime
   directories are outside the replacement set.
3. JSON validation, import, and merge-check use the same document contract.
   Invalid inputs produce structured validation failures rather than partial
   state.
4. Canonical encoding removes `undefined`, preserves permitted `null`, and is
   round-trip tested. Legacy Undo documents remain decodable for historical
   audit and gate evaluation, while Todo, Deferred, and Constraint remain the
   current work surface. No tool or CLI can create or modify Undo records
   anymore.
5. CLI JSON commands expose validation, import/export, merge-check,
   ref-based review summary, and audit summary without changing the logical
   canonical schema.
6. `project.json` persists `settings.content_locale` as a concrete BCP 47
   locale. Missing legacy values decode as `null` and produce a non-fatal
   `PROJECT_CONTENT_LOCALE_UNRESOLVED` warning; they are never inferred or
   silently stored as `auto`.
7. Audit compaction is explicit and backward compatible. A compacted project
   stores immutable events and ordinary-write receipts in one hashed operation
   envelope per operation. Readers expand envelopes back into the same logical
   canonical documents, while malformed or digest-mismatched containers fail
   closed. Loose legacy documents remain readable.
8. `json compact-audit --pack-closed-version-id <id>` may seal audit records
   related to an already closed Version into a hashed pack. Packed records are
   immutable, survive later aggregate replacement, and remain visible through
   normal JSON reads. Open Versions cannot be packed.

## Evidence

`packages/json/src/codec.ts`, `filesystem.ts`, `audit-storage.ts`,
`audit-summary.ts`, `importer.ts`, `merge-check.ts`, `validator.ts`, and their
tests are the source of truth.
