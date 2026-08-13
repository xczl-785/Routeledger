# NF1 MCP registry extraction plan

Status: NF1-06 implementation complete. Capability extraction and contract
equivalence verification finished on 2026-08-13.

## Objective

Reduce the concentration in `packages/mcp/src/index.ts` while preserving
`createRouteLedgerMcpRegistry` and `RouteLedgerMcpRegistry` as the public
facade. The change is organizational: tool names, order, profile visibility,
schemas, descriptions, annotations, RouteLedger risk metadata, preflight,
handlers, response envelopes, instructions, and runtime identity remain
equivalent.

## Baseline shape before NF1-06

Before extraction, `createRouteLedgerMcpRegistry` owned four different concerns:

1. pure schema and tool-contract construction;
2. binding/runtime/service closure creation;
3. 48 inline tool definitions and handlers;
4. profile filtering, handler lookup, invocation, error mapping, session
   rebinding, and registry disposal.

At that baseline, the 48 registrations occupied one ordered array from roughly
line 1,834 through 4,080. `tools` and `getTool` exposed the filtered
definitions; `handlers` and `invoke` executed the same filtered registrations.
Two Mission Control tools were `source-only`, producing 48 visible tools in
`full` and 46 in `json-only`.

The new characterization manifest in commit `1130900` freezes the complete
semantic contract and order of both profiles. It is the primary equivalence
gate for every slice below.

## Target internal boundaries

The internal design should use three layers:

```text
public index facade
  -> registry runtime/invocation kernel
    -> ordered capability registration factories
      -> pure tool-contract construction
```

### Pure tool-contract construction

`registry/tool-contract.ts` should own:

- `ToolAnnotations`, `ToolMeta`, `ToolDefinition`, and internal narrative,
  registration, risk, visibility, and handler types;
- risk-to-annotation/approval metadata construction;
- shared `responseLocale` and `expectedRouteLedgerRoot` schema decoration;
- narrative formatting and `defineTool`.

It must not import storage, binding, RouteLedgerService, authorization, UI, or
host adapter modules. `packages/mcp/src/index.ts` re-exports the currently public
types so package consumers see no export-path change.

### Registry runtime/invocation kernel

The facade keeps ownership of:

- the mutable one-process binding and session-rebind lifecycle;
- runtime and service construction/disposal;
- preflight and exact expected-root enforcement;
- success/error runtime-context metadata;
- profile filtering, `getTool`, `invoke`, unknown-tool behavior, and cleanup;
- server info, capabilities, instructions, and public return shape.

These are cross-tool correctness boundaries and should not move during the
first capability extraction.

### Capability registration factories

Each capability module returns an ordered `ToolRegistration[]` from a narrow,
capability-specific dependency object. It must not receive the entire registry
closure. Dependencies are named operations such as `readBinding`,
`withCurrentRuntimeContextMeta`, or `requireRuntime`, so hidden coupling is
visible in the factory signature.

Proposed modules, in extraction order:

1. `capabilities/mission-control-tools.ts` — two source-only diagnostic tools.
2. `capabilities/context-tools.ts` — context, next action, drift, closeout,
   window/list, gate, and structure/guide reads.
3. `capabilities/work-tools.ts` — Todo, Deferred, and Constraint writes.
4. `capabilities/version-tools.ts` — initialization, locale, preparation,
   completion, version tree proposals, transition, advance, close, and
   shutdown.
5. `capabilities/binding-tools.ts` — discovery, planning, activation, and host
   config only after the session-rebind boundary is characterized locally.
6. `capabilities/l3-tools.ts` — authorization status/policy/profile plus
   propose, execute, approve, commit, and reject last.

The final ordering is composed explicitly in the facade. Module import order
must never become implicit tool order.

## Implementation slices

### R1. Extract the pure tool-contract kernel

Move only pure types and functions into `registry/tool-contract.ts`. Leave all
48 registrations and every handler byte in `index.ts`.

Exit gate:

- CodeGraph shows no runtime/storage/service dependency entering the new file;
- current public types remain re-exported from `@routeledger/mcp`;
- full and JSON-only tool contract manifests are unchanged;
- focused tool-description/public-export tests, typecheck, and lint pass.

Rollback is deletion of the new file plus restoration of the local helper
block; no capability or handler movement is involved.

### R2. Extract Mission Control registration

Move exactly `open_mission_control` and `get_mission_control_status` into the
first capability factory. Its dependency object is limited to:

- schema/registration constructors;
- `readBinding`;
- `resolveMissionControlRoots`;
- `loadMissionControlSourceModule`; and
- `withCurrentRuntimeContextMeta`.

This seam is first because it is two tools, read-only, diagnostic,
source-profile-only, and isolated from route mutation and authorization. The
profile manifest directly proves 48/46 visibility.

Exit gate:

- exact tool order and every contract digest remain unchanged;
- `mcp-e2e.test.ts` proves JSON-only omission and full source behavior;
- mission-control launcher/status tests pass;
- no route, storage, binding-switch, or L3 handler moves in the commit.

### R3 and later. One capability at a time

Before each module, query CodeGraph for its handlers and closures, add only the
missing seam-local characterization, move the smallest coherent registration
group, and rerun the manifest plus affected suites. Binding activation and L3
remain last because they own mutable session state and trusted authorization.

## Invariants and failure checks

Every source slice must preserve:

- the exact 48/46 ordered tool lists and all per-tool contract digests;
- shared input decoration and optional-but-runtime-required root semantics;
- source-only visibility and JSON-only plugin behavior;
- binding preflight before handler side effects;
- business errors as tool-level error results and protocol errors at the same
  JSON-RPC boundaries;
- active project metadata derived from inspected runtime state, never tool
  arguments;
- one registry binding, rebind rollback, resource cleanup, and unknown-tool
  behavior;
- exact authorization and L3 commit semantics without adapter widening.

## Generated runtime and commit policy

Source/test movement and its generated JSON-only runtime update belong to the
same completed capability slice so the shipped plugin does not lag behind the
source. Generated files must come only from the repository build command and
must be reviewed as mechanical consequences of the source move. A formatting
or module-layout digest change does not by itself authorize a plugin SemVer
bump; NF1-09 makes the release decision after comparing behavior and bytes.

Documentation-only planning, R1, R2, and every later capability are separate
commits. Do not combine MCP registry movement with `RouteLedgerService`,
storage, recovery, schema, or release-policy changes.

## Closeout

The registry now keeps its public facade, explicit cross-capability order,
runtime/session composition, preflight, invocation, and disposal in
`packages/mcp/src/index.ts`. Tool registrations and handlers are extracted by
Binding, Mission Control, Context, Version, Work, and L3 capability under
`packages/mcp/src/capabilities/`; shared contracts and transport schemas live
under `packages/mcp/src/registry/`. The characterized surface remains 48 tools
in `full` and 46 in `json-only`, with the same order, schemas, metadata, and
handler behavior.
