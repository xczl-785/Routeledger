# NF1 characterization-test plan

Status: NF1-04 completed. No production refactor is authorized by this
document.

## Goal

Freeze the externally observable and safety-relevant behavior that the MCP
registry and `RouteLedgerService` extractions must preserve. Prefer existing
tests when they already detect meaningful drift; add narrow contract tests only
where the current suite leaves a refactor seam under-specified.

Characterization tests describe current supported behavior. Known defects and
recovery gaps remain explicit gaps and must not be converted into desirable
assertions.

## Existing coverage assessment

| Contract area | Existing protection | Assessment |
| --- | --- | --- |
| Core public exports | `public-api.test.ts`, `public-exact-authorization-api.test.ts`, TypeScript project build | Protects selected public commands and removed authorization vocabulary, but does not freeze the complete application error-code surface. |
| MCP tool registry | `tool-description-contract.test.ts`, `mcp-registry-protocol.test.ts`, `mcp-e2e.test.ts` | Strong risk/count/representative-schema coverage. Exact tool membership and each tool's complete semantic contract are not captured together, so modular registration could drop or subtly alter one tool while counts remain equal. |
| MCP error envelopes | `mcp-registry-protocol.test.ts`, write-guard and locale tests | Strong representative protocol coverage. The complete `APPLICATION_ERROR_CODES` compatibility list is not frozen directly. |
| Canonical JSON | `json-codec.test.ts`, `json-validate.test.ts`, canonical fixtures, `json-first-storage.test.ts` | Already strong: stable bytes across collection order, round-trip, validation, replacement, lock, conflict, and stale-snapshot behavior. No new broad snapshot is justified before an actual extraction touches this boundary. |
| Physical binding | `mcp-binding.test.ts`, `mcp-write-guards.test.ts`, `mcp-runtime-context.test.ts` | Already strong across split roots, symlinks/containment, expected-root preflight, session rebind, and runtime context. Add tests only for a concrete extraction seam. |
| Representative L3 transitions | `service-approval.test.ts`, `service-authorization-grant.test.ts`, `execute-l3-operation.test.ts`, local-authority suites | Already strong for proposal, decision, claim, mutation, finalize, replay, mismatch, restart receipt, and concurrency. Persisted `commitOwners` process-death recovery is a known functional gap, not a characterization target. |

## Ordered slices

### C1. Complete MCP tool-contract manifest

Add one deterministic contract test that covers both full and JSON-only runtime
profiles. For every visible tool it must capture:

- ordered tool name and profile visibility;
- title and compact description;
- complete input schema after shared root/locale decoration;
- standard annotations; and
- RouteLedger risk metadata.

Use stable key ordering and one digest per tool so a failure identifies the
changed tool without committing a very large duplicated JSON fixture. Keep the
exact ordered tool-name arrays readable in the test.

This slice is the entry gate for NF1-06 MCP registry extraction.

### C2. Application error compatibility manifest

Add a focused core test for the ordered, unique `APPLICATION_ERROR_CODES` list
and the stable `ApplicationError` fields (`name`, `code`, `message`, optional
`details`). Do not assert localized presentation strings here.

This slice is the entry gate for NF1-07 application-service extraction.

### C3. Seam-local additions

Before each later extraction, use CodeGraph to inspect the exact moved symbols
and callers. Add only missing behavior at that seam. Likely examples are query
facade return shapes or registry profile filtering; canonical, binding, and L3
tests should be reused rather than duplicated unless the call graph exposes a
specific unprotected branch.

## Sensitivity check

Characterization tests normally pass against the existing implementation. To
prove that a new test is effective, temporarily perturb one frozen value in the
implementation or captured contract, run the focused test and confirm the
expected failure, then revert the perturbation with an explicit patch and run
the focused test green. Never commit the perturbation.

Each slice must record:

1. the exact deliberate perturbation;
2. the focused failing assertion;
3. the clean-tree green command; and
4. the surrounding suite command.

## Acceptance and commit boundary

- C1 and C2 are separate commits.
- Test-only changes do not rebuild generated plugin runtime bytes.
- No production implementation change is allowed in NF1-04.
- Focused tests run first; then the relevant package suite; root validation is
  repeated at the NF1-04 close gate.
- A flaky, platform-sensitive, or timing-heavy assertion is rejected rather
  than hidden behind a longer timeout.

## Completion evidence

- C1 commit `1130900` freezes all 48 full-runtime tool contracts, the 46-tool
  JSON-only visibility subset, ordering, schemas, descriptions, annotations,
  and RouteLedger risk metadata. A one-character digest perturbation failed on
  the intended tool; the MCP package then passed 23 files and 214 tests.
- C2 commit `7bc70a9` freezes all public application error codes and structured
  `ApplicationError` fields. A one-code perturbation failed on the intended
  value; the core suite then passed 26 files and 289 tests.
- The first root close-gate run exposed a separate transient Windows `EPERM`
  during owner-checked authority lock release. Commit `5a3772d` fixes that race
  independently with bounded retry and a fresh `lockId` check before every
  retry. Its injected regression ran five times, the authority pair passed 24
  tests, and the MCP package passed 23 files and 215 tests.
- Final `pnpm test`, `pnpm typecheck`, and `pnpm lint` passed. The root command
  also completed plugin-release, attestation, workflow, and app-server JSONL
  checks.
