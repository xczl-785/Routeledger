# RouteLedger interface redesign QA

## Target and evidence

- Selected visual target: `prototypes/routeledger-ui-comparison/public/references/version-horizon.png` (1487 × 1058).
- Production desktop capture: `packages/ui/version-horizon-fund-claw.jpg` (1472 × 1087).
- Production mobile capture: `packages/ui/version-horizon-mobile.jpg` (375 × 1887).
- Runtime sources: the RouteLedger repository itself and the real Fund Claw RouteLedger database. No fixture or hard-coded prototype data was used.

## Visual comparison

- Preserved the selected composition: quiet white shell, centered project context, one dominant current-Version column, subordinate past/next/future columns, blue current-route accent, and collapsible density.
- Preserved the requested hierarchy: current position and Todo/Deferred counts first; next Version second; later Versions third. Constraints stay available but collapsed by default.
- Intentional production differences: the brand reads `RouteLedger`, no `V2` label appears, actual project/version states replace the reference copy, and approval/audit data is available only from the secondary history drawer.
- The old permanent sidebar, dashboard cards, four-view navigation, engineering metadata, next-action panel, and theme switch are absent.

## Interaction and responsive checks

- Project context popover opens and explains the current single-project binding without exposing filesystem paths or project IDs.
- Todo and Deferred tabs switch their real current-Version lists.
- Constraints expand/collapse independently.
- Long future routes expand from the first three items and collapse again.
- History and approval records open in a read-only drawer and close without changing project state.
- The history drawer is inert while closed; opening moves focus to its close control, Escape closes it, and focus returns to the history trigger.
- Downstream traversal counts the complete linked route (with cycle protection); only rendering is collapsed to three rows.
- At 390 px CSS width the past column is removed, current/next/future become a single vertical flow, and the Deferred target Version moves below its title to avoid crushing the content column.
- Layout inspection reported no horizontal overflow at desktop or mobile widths.
- Browser console: no errors.

## Automated checks

- `pnpm --filter @routeledger/ui run build`: passed.
- `pnpm --filter @routeledger/ui run test`: passed, 10 tests.
- `pnpm typecheck`: passed.
- `pnpm test`: passed, 669 tests with 1 skipped.
- `pnpm exec eslint packages/ui/src --ignore-pattern 'packages/*/dist/**'`: passed.

## Result

Passed for independent review. The remaining judgment is product experience, not a known implementation blocker.
