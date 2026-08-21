# WorkItem lineage identity

Status: implemented contract. R8 establishes the stable in-Project identity
that connects Todo, Deferred, and readable legacy Undo records.

## Context

RouteLedger exposes Todo, Deferred, and Constraint as work vocabulary. A Todo
can be deferred, a Deferred can activate into a Todo, and old Undo records can
remain as audit history. Without an explicit identity across those transitions,
the same underlying work could be counted, routed, or audited as unrelated
objects.

## Decision

`WorkItem` is a supporting stable lineage identity inside the `Project`
aggregate. It is not an independent aggregate, repository, CRUD resource, or a
fourth user-operable work surface. Todo, Deferred, and legacy Undo are records
in that lineage. Creation, conversion, reopen, and persistence happen as one
Project aggregate mutation, while `WorkItem.id` remains stable across the
records that represent the same work.

## Invariants

1. An active WorkItem has exactly one current child record: Todo in `wait` or
   `running`, or Deferred in `pending`. Its `activeRecordType` and
   `activeRecordId` point to that record. Retained legacy Undo records may
   independently remain in `wait` for audit and gates.
2. The old `activeRecordType: "undo"` pointer form remains decodable: it must
   point to its same-Project `wait` Undo and cannot coexist with a current
   Todo or Deferred. Other retained `wait` Undo records do not participate in
   pointer validation.
3. A closed WorkItem has no current child record and both active-pointer fields
   are `null`; retained legacy `wait` Undo audit history is allowed.
4. Every child `workItemId` refers to a WorkItem in the same Project aggregate;
   aggregate project-scope and foreign-key validation remain mandatory.
5. Closed, converted, activated, and resolved records are retained as history.
   Conversion or reopen continues the existing WorkItem ID rather than creating
   a replacement identity.

The Core `validateWorkItemLineage` validator is the single executable form of
these rules. JSON validation and SQLite aggregate persistence call that same
validator.

## Rejected alternatives

- **Independent WorkItem aggregate:** rejected because a separate repository or
  write lifecycle would break atomic Project transitions and add a user surface
  that RouteLedger does not need.
- **Pure read-model projection:** rejected because the stable ID must survive
  authoritative Todo/Deferred/Undo transitions and be validated before
  persistence.
- **A fourth user work surface:** rejected. Users continue to act through Todo,
  Deferred, and Constraint; WorkItem remains supporting bookkeeping and audit
  identity.

## Compatibility

The existing `validateWorkItemActive` export remains as a compatibility alias.
Stored JSON and SQLite schema remain unchanged. Historical terminal records
remain readable. Snapshots that previously allowed two active child records for
one WorkItem are invalid and fail closed; no migration or storage-port split is
introduced here.

## Consequences

Aggregate writers must persist a complete Project snapshot that satisfies the
lineage validator. Adapters must not copy the lineage rules. Storage-port
restructuring, if needed, belongs to R10 rather than this decision.
