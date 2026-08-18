import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createRouteLedgerMcpRegistry, type ToolDefinition } from "../index.js";

const REMOVED_LEGACY_TOOLS = [
  "create_undo",
  "reassign_undo",
  "carry_forward_undo",
  "resolve_undo_as_downstream_input",
  "close_undo"
];

const EXPECTED_TOOL_CONTRACT_DIGESTS = {
  get_runtime_context: "7296318b061d1f10670f49d26b9f5e71ef3730c96f399f9becd02fa0d898707f",
  get_l3_authorization_status: "b2c7e4298325f6ceffb148f374c4e0d8fa379557d7dbfbbf8f8960f81c82e103",
  recommend_l3_authorization_profile: "a41ccd0201ea31ec142cb1863064837100f6290bcaf00db15365bbfde4ad525c",
  discover_routeledger_roots: "6879ae0e481d23dfcdbb120f176a2b69bd791314453b05d9da5d5fb6b70097ab",
  plan_routeledger_binding: "a72042d8451418974b769e00d28393e86595f0c8077b1585a525ac6c900503e8",
  activate_routeledger_binding: "a611c1cab06c442358e39f042afcf95c6b724c99e0d63bf1557110b6630af5a4",
  render_host_binding_config: "0416054f0f4f0f4d76258b293be5c0c52d7fc7f9efc266ad55c22bce00fc72d9",
  write_host_binding_config: "b18fb6267a005ac2419708e0e9cc6678a08bc554183775f3132d96fc5b207d0c",
  open_mission_control: "0d32fcc71bd108c6f392f8a781f37fd85a7082a75a25879be89f845a06bfe45c",
  get_mission_control_status: "2492089957b2e36211d64a6b36e3041ec2f86b32633fc978a11a406bde526632",
  stop_mission_control: "794d4d35be4f394b2f200a0dc3607763e6b9e30f5740fd308f0abf785db7fa3f",
  init_project: "7e38acb9d746569b0fc140911488b150f8014922ef759d9e82549fdbfea487e3",
  set_project_content_locale: "779bb39842ff4de414d9610107aef073a8bd05aab5692b2bc5e18ab50ef1654c",
  get_current_context: "0d3d66dc13ca3810f34a18d873a0e5caa5e42fce4e663edff93dcc586689d83d",
  next_action: "cdbead82aa238790ede0af23b6f7665e119fbabcba159a116ef55f1348812abe",
  check_doc_drift: "7675168031f1c3d3b1842ce9963c076a8d91c26c324af0e8d360136b31486add",
  summarize_version_closeout: "66ec9c27dce60e1c53e16f8dbea8b45013b0e79ee74cb359bd29ee4480e657c4",
  plan_version_closeout: "22b55767b5b2bfd4d359b274d772cfbaf4d5697bc835a5cf7ba1ec6c127b7a3f",
  list_versions_window: "c40ea761829df3828b19e2a0fbfd6762890b4430a61c952add2ef8fcc814fe47",
  list_versions: "480db027872daaa23e514025f6de89f52ab5b7e4ceedda85a82d9746288785d9",
  check_start_gate: "a9542c5ef093c5388343fc7b93aa73a0a0cdb6c19336019612063e6fc1f59596",
  check_close_gate: "90b680739c328205e93ba3cf0ff72cedb13cce4e76104b5a4569cdc9917758f6",
  get_version_structure: "855d7bd3f338acf19de2fff94f7686a6c242bc8935845d65927855b2cfa1263e",
  get_version_transition_guide: "9fb74594bf4b8b44c878aa90c2ed45880f93abf6e26e3fd9f50a0ba7464deabf",
  recommend_l3_authorization_policy: "29d6aa2d56650582026660cf00531373ad6faa3596b65d3630d8d92ce72f1c9f",
  list_l3_proposals: "166213f9bbec88e1a35ce92b5376c93170370af0d67388847e3f5d79e4b8838d",
  get_l3_proposal: "a0aedcb4c5e004650c9f4be127292aa3310e752de41a48151f8a2713e93b5434",
  preflight_or_propose_version_batch: "e5014f724d092d503cf561a9539ae7dfd3fc759b58ad9cbe1550dae167a54a84",
  preview_or_propose_version_transition: "d72e22ef1d2a3aff66c709f2a94c21e2fcdfb38ebeeec5ae9237106f1857a2f6",
  propose_version_advance: "90a5193920bd06ce91113acad2a8d6d32ee355f95b100181899bbddb0ef988b2",
  preview_or_propose_version_close: "0dcbce1e698a7e2add1fa14382cddf3ba81c832fa3110980f0653dc09b187c33",
  preview_or_propose_forced_version_shutdown: "8c9fd3ac0cc76f8734a71a48eeaba8089be3e526aeb81b2b6521d48519bb76d0",
  create_todo: "312cecf5f3e5a7a82d75386dd5f6ec2a47d97244d7462b569ca1833ee56fcca7",
  close_todo: "c9897b4ff3152e9c9809ef43d7a040cf4260da679f3c2cbd86895eb8948cf150",
  defer_work: "3b1a5ed35a696c8efe0917c3c4f3d77572831d9325c283fc8a42497ae3b8beb8",
  review_deferred: "17155553bca9f57695dd1d61c5781abef4eff393dc365f110e37f613e542ec52",
  record_constraint: "f7ec201d21b039a840633eb29cc4430dafd725654913a88eff3409cbb9f82598",
  retire_constraint: "29cf7c05560330ae6251ed00120418ec170a71b6a23a0f51ca029b790ae46001",
  prepare_version: "0f9d1e7ab1dc22349ed9f7b0bf028e9dbb39f74e0c1f9c341ef6cd2e518bbb57",
  mark_version_complete: "b06f40659efb3cc29f0ece168e1a805910475bf83cf99c74820a0435b6c07632",
  propose_version_creation: "6b5692f75359615e71f336828bbf13f4ebe7bba16f2b70ef2b8c03c16698ff17",
  propose_version_insertion: "26504c21d63320945789d98734aca9434ead884afa5104047ca95619ca5f69fc",
  propose_child_version_creation: "343b24372a8d420710548679f93c86c409f9264b1da147c632c66494fc292868",
  propose_version_reorder: "a0f6cdd139d66455dfc00ab27235f297519e7c746ae444e75ec0be57c2896e83",
  propose_l3_operation: "539422107c5281075c037aee09d5eba5ee93612d8da05c8d1cb333a24288e540",
  execute_l3_operation: "a39420cc1d8c96860b013e5d9dda04f4d5ee681ba940d125b9170d9dd37db81f",
  approve_l3_operation: "83adb2fb39b423d2ddc6dd08c60bb45abca119773228381e64ac6df75b12648a",
  commit_l3_operation: "53e4496ff3e58162f002d8407e0639293938f6cdabee2a067cbc42ddd36e03c0",
  reject_l3_operation: "9d4a51cb4510c7a41a13159216f0d8d75004f616c9652bcd82e7c87ffe0bcdfc"
} as const;

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, item]) => [key, sortKeys(item)])
    );
  }
  return value;
};

const captureToolContracts = (runtimeProfile: "full" | "json-only") => {
  const registry = createRouteLedgerMcpRegistry({ runtimeProfile });
  try {
    return Object.fromEntries(
      registry.tools.map(({ name, ...contract }) => [
        name,
        createHash("sha256")
          .update(JSON.stringify(sortKeys(contract)))
          .digest("hex")
      ])
    );
  } finally {
    registry.close();
  }
};

const getTool = (tools: ToolDefinition[], name: string): ToolDefinition => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`Missing tool ${name}.`);
  }
  return tool;
};

describe("MCP tool description contract", () => {
  it("freezes every tool contract and runtime-profile visibility", () => {
    const fullContracts = captureToolContracts("full");
    const jsonOnlyContracts = captureToolContracts("json-only");
    const expectedJsonOnlyContracts = EXPECTED_TOOL_CONTRACT_DIGESTS;

    expect(Object.keys(fullContracts)).toEqual(Object.keys(EXPECTED_TOOL_CONTRACT_DIGESTS));
    expect(fullContracts).toEqual(EXPECTED_TOOL_CONTRACT_DIGESTS);
    expect(Object.keys(jsonOnlyContracts)).toEqual(Object.keys(expectedJsonOnlyContracts));
    expect(jsonOnlyContracts).toEqual(expectedJsonOnlyContracts);
  });

  it("keeps the public tool budget, risk shape, and binding assertion intact", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const tools = registry.tools;
      const readOnly = tools.filter((tool) => tool._meta.routeledger.riskLevel === "read-only");
      const writes = tools.filter((tool) => tool._meta.routeledger.riskLevel === "write");
      const highRisk = tools.filter((tool) => tool._meta.routeledger.riskLevel === "high-risk");

      expect(tools).toHaveLength(49);
      expect(readOnly).toHaveLength(21);
      expect(writes).toHaveLength(23);
      expect(highRisk).toHaveLength(5);
      expect(writes.concat(highRisk)).toHaveLength(28);
      for (const tool of writes.concat(highRisk)) {
        const required = (tool.inputSchema.required ?? []) as string[];
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
        expect(properties).toHaveProperty("expectedRouteLedgerRoot");
        expect(required).not.toContain("expectedRouteLedgerRoot");
      }
      for (const name of [
        "preview_or_propose_version_transition",
        "preview_or_propose_version_close",
        "preview_or_propose_forced_version_shutdown"
      ]) {
        const tool = getTool(tools, name);
        const properties = (tool.inputSchema.properties ?? {}) as Record<
          string,
          { description?: string }
        >;
        const mode = properties.mode;
        const rootAssertion = properties.expectedRouteLedgerRoot;

        expect(tool.description).toContain("Binding-sensitive");
        expect(mode?.description).toContain("dry_run is a binding-sensitive preview");
        expect(mode?.description).toContain("expectedRouteLedgerRoot");
        expect(rootAssertion?.description).toContain("including dry_run previews");
      }
      for (const removedTool of REMOVED_LEGACY_TOOLS) {
        expect(tools.find((tool) => tool.name === removedTool)).toBeUndefined();
      }
    } finally {
      registry.close();
    }
  });

  it("keeps descriptions compact, specific, and free of repeated public boilerplate", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const descriptions = registry.tools.map((tool) => tool.description);
      expect(descriptions.reduce((total, description) => total + description.length, 0)).toBeLessThanOrEqual(3500);
      for (const description of descriptions) {
        expect(description.length).toBeLessThanOrEqual(150);
      }

      const repeatedLongSentences = new Map<string, number>();
      for (const description of descriptions) {
        for (const sentence of description.split(/(?<=[.!?])\s+/)) {
          const normalized = sentence.trim();
          if (normalized.length >= 80) {
            repeatedLongSentences.set(
              normalized,
              (repeatedLongSentences.get(normalized) ?? 0) + 1
            );
          }
        }
      }
      expect([...repeatedLongSentences.values()].every((count) => count === 1)).toBe(true);
    } finally {
      registry.close();
    }
  });

  it("exposes exact-only L3 authorization schemas", () => {
    const registry = createRouteLedgerMcpRegistry({});
    try {
      const l3Tools = registry.tools.filter((tool) =>
        [
          "execute_l3_operation",
          "propose_l3_operation",
          "approve_l3_operation",
          "commit_l3_operation",
          "get_l3_authorization_status",
          "recommend_l3_authorization_profile",
          "recommend_l3_authorization_policy"
        ].includes(tool.name)
      );
      const publicContract = JSON.stringify(
        l3Tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      );
      for (const forbidden of [
        "authorizationGrantId",
        "grantStore",
        "issuePreauthorization",
        "maxUses",
        "sessionId",
        "time_window"
      ]) {
        expect(publicContract).not.toContain(forbidden);
      }
      expect(publicContract).toContain("decisionBudget");
      expect(publicContract).toContain("pendingOperationId");
    } finally {
      registry.close();
    }
  });

  it("publishes exact structured output contracts for ten priority task-level tools", () => {
    const registry = createRouteLedgerMcpRegistry({});
    try {
      const priorityToolNames = [
        "get_current_context",
        "next_action",
        "create_todo",
        "close_todo",
        "defer_work",
        "review_deferred",
        "record_constraint",
        "retire_constraint",
        "plan_version_closeout",
        "preview_or_propose_version_close"
      ];
      expect(
        registry.tools
          .filter((tool) => tool.outputSchema !== undefined)
          .map((tool) => tool.name)
          .sort()
      ).toEqual(priorityToolNames.slice().sort());
      for (const name of priorityToolNames) {
        const outputSchema = getTool(registry.tools, name).outputSchema as Record<
          string,
          unknown
        >;
        const properties = outputSchema.properties as Record<string, unknown>;
        expect(outputSchema).toMatchObject({
          type: "object",
          additionalProperties: false,
          required: ["ok"]
        });
        expect(properties).toHaveProperty("data");
        expect(properties.data).not.toEqual({ type: "object" });
        expect(properties).toHaveProperty("error");
      }
    } finally {
      registry.close();
    }
  });

  it("keeps close residual-audit schemas free of the removed legacy create_undo routing", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const closeVersion = getTool(registry.tools, "preview_or_propose_version_close");
      const properties = closeVersion.inputSchema.properties as Record<string, Record<string, unknown>>;
      const residualAudit = properties.residualAudit;
      const alternatives = residualAudit?.anyOf as Array<Record<string, unknown>>;
      const legacyArray = alternatives.find((candidate) => candidate.type === "array");
      if (legacyArray === undefined) {
        throw new Error("Missing legacy residual audit array schema.");
      }
      const itemProperties = (legacyArray.items as { properties: Record<string, Record<string, unknown>> })
        .properties;
      const destinationEnums = (itemProperties.destination?.anyOf as Array<Record<string, unknown>>)
        .flatMap((candidate) =>
          Array.isArray(candidate.enum) ? (candidate.enum as string[]) : []
        );

      expect(destinationEnums).not.toContain("create_undo");
      expect(itemProperties).not.toHaveProperty("preferredResolutionVersionId");
    } finally {
      registry.close();
    }
  });

  it("snapshots representative descriptions and keeps shared discipline in instructions", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      expect(
        Object.fromEntries(
          [
            "activate_routeledger_binding",
            "get_current_context",
            "preview_or_propose_version_close",
            "defer_work",
            "propose_version_creation",
            "commit_l3_operation"
          ].map((name) => [name, getTool(registry.tools, name).description])
        )
      ).toMatchInlineSnapshot(`
        {
          "activate_routeledger_binding": "Activate an explicit MCP binding. Input: workspaceRoot. Warning: switching an established Codex session requires confirmProjectSwitch=true.",
          "commit_l3_operation": "Commit an approved L3 proposal. Input: pendingOperationId and approvalArtifactId. Warning: consumes once; exact retries replay.",
          "defer_work": "Create Deferred work for a future review. Input: mode, targetReviewVersionId, and Todo or new-work fields.",
          "get_current_context": "Read current project, route, work, and gate context.",
          "preview_or_propose_version_close": "Binding-sensitive close preview or proposal. Input: mode and versionId. Warning: proposal needs a passing gate.",
          "propose_version_creation": "Propose a top-level version, including append-only continuation after a closed top-level tail. Warning: returns a pending L3 operation.",
        }
      `);
      expect(registry.instructions).toContain("CONFIRMATION_REQUIRED");
      expect(registry.instructions).toContain(
        "execute_l3_operation performs the proposal, decision, artifact, and commit chain"
      );
      expect(registry.instructions).toContain("Project files are never authorization authority");
    } finally {
      registry.close();
    }
  });
});
