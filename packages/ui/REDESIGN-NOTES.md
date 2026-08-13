# Mission Control interface rebuild

## Target

The selected visual truth is the preserved `Version Horizon` prototype at
`prototypes/routeledger-ui-comparison/public/references/version-horizon.png`.
The production surface remains named RouteLedger Mission Control; there is no
`V2` product suffix and no parallel legacy UI route.

## Current implementation inventory

| Area | Current implementation | Disposition |
| --- | --- | --- |
| Runtime | `src/server/launcher.ts`, one server instance per exact workspace/project binding | Keep |
| Production data | read-only `GET /api/state`, built by `mission-control-vm.ts` from canonical JSON | Keep |
| UI frame | dark/light admin shell, permanent sidebar, four separate views | Remove |
| Primary hierarchy | aggregate counters, diagnostics, next action and project internals | Replace with current route position, current work, next Version and later direction |
| Roadmap | separate vertical list | Fold into the single Version Horizon page |
| Current work | separate Todo/Deferred/Constraint cards | Fold into the dominant current-Version column |
| Tree | separate four-column technical tree | Replace with parent-route breadcrumb and collapsed child count |
| Audit | right drawer with approvals, events and legacy records | Keep as secondary read-only disclosure |
| Proposals | top-level drawer/action | Remove from primary UI; show only inside history when records exist |
| Theme | dark-first theme switch | Remove; selected visual truth is a light neutral product surface |

## Design contract

| Axis | Selected prototype | Production target |
| --- | --- | --- |
| Frame | one bright continuous desktop surface | full-width single page, no sidebar |
| Geometry | past / current / next / later columns | current column dominant; history and later columns collapsible |
| Typography | neutral product sans, restrained sizes | system sans stack with Chinese fallbacks |
| Color | white, gray separators, blue current accent | tokenized light palette, semantic status accents only |
| State | loading, error, empty, current, collapsed history/detail | all explicit without introducing write behavior |
| Interaction | project context, hide history, expand constraints/later/history | read-only controls only |

## Data-source boundary

- Production source: `/api/state`; no prototype fixtures enter production code.
- Current server instance remains bound to one exact project. The project name is
  displayed as context, not as a fake multi-project selector.
- Project switching remains a future launcher/runtime capability; the visual
  control will not claim it exists before the server can provide multiple
  healthy project destinations.
- Version columns and route windows are derived client-side from the existing
  `roadmap` pointers and `currentVersion`; canonical JSON remains the authority.

## Verification

- UI unit/VM tests.
- TypeScript and production build.
- Runtime against this repository's real `.routeledger` data.
- Same-viewport screenshot comparison against the selected prototype.
- Browser interaction and console checks.
- One independent reference-driven UI review, with one fix round if needed.
