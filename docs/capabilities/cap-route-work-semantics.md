# cap-route-work-semantics

## Stable semantics

| Term | Current meaning |
| --- | --- |
| Todo | Work that belongs to the current version and is not complete. |
| Deferred | Work intentionally not done now, with a target version for review. |
| Constraint | A project or version rule that must not be violated. |
| Out of scope | Work not committed for the current scope; it needs a new decision to return. |
| Rejected | A reviewed option that is not adopted. |
| Undo | A legacy compatibility concept, not the default work-management surface. |

## Current rules

1. Agents classify work by whether it is current work, future review work, or
   a rule. They do not turn every unresolved item into a Todo.
2. Deferred work must remain linked to a finite review target. Review resolves,
   re-defers, or changes its classification explicitly.
3. Constraints do not contribute to Todo or Deferred completion counts.
4. Default context and agent workflows favor Todo, Deferred, and Constraint;
   legacy Undo is available only for explicit compatibility or audit work.

## Evidence

`packages/core/src/domain/`, `packages/core/src/services/`,
`packages/core/src/application/`, and their tests define the behavior.
