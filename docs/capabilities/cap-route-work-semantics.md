# cap-route-work-semantics

## Stable semantics

| Term | Current meaning |
| --- | --- |
| Todo | Work that belongs to the current version and is not complete. |
| Deferred | Work intentionally not done now, with a target version for review. |
| Constraint | A project or version rule that must not be violated. |
| Out of scope | Work not committed for the current scope; it needs a new decision to return. |
| Rejected | A reviewed option that is not adopted. |
| Legacy Undo | A historical audit record only; no write or recommendation surface remains. |
| WorkItem | A supporting Project-aggregate lineage identity shared by Todo, Deferred, and retained legacy Undo records; it is not a user-operable work surface. |

## Current rules

1. Agents classify work by whether it is current work, future review work, or
   a rule. They do not turn every unresolved item into a Todo.
2. Deferred work must remain linked to a finite review target. Review resolves,
   re-defers, or changes its classification explicitly.
3. Constraints do not contribute to Todo or Deferred completion counts.
4. Default context and agent workflows use Todo, Deferred, and Constraint.
   Historical Undo records remain readable for audit via
   `get_current_context(includeLegacyUndo=true)` and still participate in gate
   evaluation, but there is no way to create, close, or route them anymore.
5. WorkItem remains stable when the same work converts or reopens across Todo,
   Deferred, and legacy Undo records. Current lineage is exactly one writable
   Todo or Deferred; retained legacy Undo may independently stay `wait` for
   audit and gates, including under a closed WorkItem. Only the old
   pointer-to-Undo form participates in legacy pointer validation. The records
   and their WorkItem are changed and persisted atomically as one Project
   aggregate.

## Evidence

`docs/architecture/work-item-lineage-identity.md`,
`packages/core/src/domain/work-item-lineage.ts`, `packages/core/src/services/`,
`packages/core/src/application/`, and their tests define the behavior.
