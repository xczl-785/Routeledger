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
5. CLI JSON commands expose validation, import/export, merge-check, and
   ref-based review summary without changing the canonical schema.

## Evidence

`packages/json/src/codec.ts`, `filesystem.ts`, `importer.ts`,
`merge-check.ts`, `validator.ts`, and their tests are the source of truth.
