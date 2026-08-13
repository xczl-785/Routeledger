# RouteLedger interface redesign QA

## Target and evidence

- Selected visual target: `prototypes/routeledger-ui-comparison/public/references/version-horizon.png` (1487 × 1058).
- Production desktop capture: `packages/ui/version-horizon-fund-claw.jpg` (1472 × 1087).
- Production mobile capture: `packages/ui/version-horizon-mobile.jpg` (375 × 1887).
- Complete-route desktop capture: `packages/ui/version-route-rail-future.jpg`.
- Complete-route mobile capture: `packages/ui/version-route-rail-mobile.jpg`.
- Read-only Version selection capture: `packages/ui/version-readonly-selection.jpg`.
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
- The Version rail renders the complete roadmap, including child-route nodes. It centers the current Version on first load, scrolls continuously toward the earliest and furthest future nodes, and exposes a `定位当前` control after the user moves away.
- The focused rail handles Arrow, Page Up/Down, Home and End keys explicitly; keyboard Home reached the earliest node and `定位当前` restored a zero-delta centered current node.
- Nested routes use computed parent depth rather than a single child flag. Fund Claw rendered 48 top-level, 7 level-1 and 3 level-2 nodes with distinct indentation.
- A `ResizeObserver` keeps an anchored current node at zero center delta across desktop → 390 px → desktop resizing. When the user has scrolled into history, resizing preserves that browsing position instead of recentering.
- Real-data checks covered Routeledger-Internal (28 total Versions and 3 child-route Versions) and Fund Claw (58 total, 46 past, 1 current, 11 future and 10 child-route Versions).
- At 390 px CSS width the current Version remains first, followed by a 440 px scrollable route rail, then next/future detail. The Deferred target Version moves below its title to avoid crushing the content column.
- Every route node is a button. Selecting a closed, shutdown or future Version changes only the center detail projection; API `currentVersionId` remained byte-for-byte identical before and after each interaction.
- Status labels use semantic but restrained colors: running green, ready blue, wait amber, suspend orange, complete muted blue, close neutral gray and shutdown muted red.
- The right-side next/later route follows the Version being inspected. Real data verified order 27 → 28 in Routeledger-Internal and future order 52 → 53 → later nodes in Fund Claw.
- All seven status tone pairs exceed a 4.5:1 text contrast ratio; measured values range from 5.56:1 to 6.68:1.
- On narrow screens, choosing a rail node returns the page to the updated detail panel; desktop selection does not reposition the page. `定位当前` controls rail position, while `查看当前 Version` controls the inspected detail.
- Layout inspection reported no horizontal overflow at desktop or mobile widths.
- Browser console: no errors.

## Automated checks

- `pnpm --filter @routeledger/ui run build`: passed.
- `pnpm --filter @routeledger/ui run test`: passed, 12 tests.
- `pnpm typecheck`: passed.
- `pnpm test`: passed, 669 tests with 1 skipped.
- `pnpm exec eslint packages/ui/src --ignore-pattern 'packages/*/dist/**'`: passed.

## Result

Passed for independent review. The remaining judgment is product experience, not a known implementation blocker.
