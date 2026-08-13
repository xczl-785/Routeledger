# RouteLedger UI comparison design QA

## Evidence

- Source visual truth:
  - `public/references/focus-and-trajectory.png`
  - `public/references/version-horizon.png`
- Browser-rendered implementation:
  - `focus-implementation.png`
  - `horizon-implementation.png`
- Combined full-view comparisons:
  - `focus-comparison.png`
  - `horizon-comparison.png`
- Viewport: 1487 x 1058 CSS px.
- Device scale factor: 1.
- Source pixels: 1487 x 1058 for both references.
- Implementation pixels: 1487 x 1058 for both pages.
- Density normalization: none required.
- State: default desktop read-only state, selected project matching each reference.

## Findings

No actionable P0, P1, or P2 mismatch remains.

- Fonts and typography: Inter plus Noto Sans SC reproduces the neutral product typography, hierarchy, wrapping, and optical weight closely. Minor glyph-width differences from the generated source remain P3 only.
- Spacing and layout rhythm: both implementations preserve the reference frame, primary region proportions, route density, separators, whitespace, and vertical rhythm. Neither page overflows at the comparison viewport.
- Colors and visual tokens: neutral surfaces, subtle borders, blue current-position accents, muted history, and amber waiting state match the reference direction.
- Image quality and asset fidelity: the designs contain no raster illustrations or product imagery. Icons use Phosphor rather than custom SVG, CSS drawings, emoji, or placeholders.
- Copy and content: visible project, Version, Todo, Deferred, Constraint, next-Version, and later-route content matches the selected design direction. Focus view includes the source priority labels.

## Focused region comparison

Focused regions were checked within the full-resolution combined images: header/project switcher, current Version header, work-count band, Todo/Deferred rows, next Version, history column, current Version metrics, Deferred table, and future Version list. Separate crops were unnecessary because each region remains readable at the full 2998 x 1102 comparison resolution.

## Comparison history

1. Initial focus capture had a five-pixel vertical overflow, omitted priority labels, and wrapped the next-Version title. Fixed by tightening panel bottom spacing, restoring priority labels, and reducing the secondary title size.
2. Post-fix focus capture is exactly 1487 x 1058 with no overflow and no remaining P0/P1/P2 issue.
3. Initial horizon capture matched the target frame and hierarchy; no P0/P1/P2 fix was required.

## Interaction and runtime checks

- Project switcher opened and changed the visible project state on both concepts.
- Focus child-route disclosure opened successfully.
- Horizon Constraints and historical-Version disclosures opened and collapsed successfully.
- Cross-concept navigation works through `/focus` and `/horizon`.
- Browser console warnings/errors checked: none.
- Production build passed.
- Sites packaging tests passed: 4/4.

## Follow-up polish

- P3: icon silhouettes differ slightly from the generated reference because the implementation uses the closest coherent Phosphor icons.
- P3: exact Chinese glyph metrics vary by locally available font fallback.

final result: passed
