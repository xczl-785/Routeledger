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
  open_mission_control: "25c14d35211ab6e9ca33a623220966fa2147a40aeadecc3afbd6b61c4dac1ccb",
  get_mission_control_status: "2492089957b2e36211d64a6b36e3041ec2f86b32633fc978a11a406bde526632",
  init_project: "7e38acb9d746569b0fc140911488b150f8014922ef759d9e82549fdbfea487e3",
  set_project_content_locale: "779bb39842ff4de414d9610107aef073a8bd05aab5692b2bc5e18ab50ef1654c",
  get_current_context: "237d3945f6093cf1a95b18c37b49619b0958b303b01b212a96f0dba6d01f356b",
  next_action: "a274cd6c3ce7d73ccd5f79502d7b008198461a5f44b0dce671d33d69a280b6ec",
  check_doc_drift: "7675168031f1c3d3b1842ce9963c076a8d91c26c324af0e8d360136b31486add",
  summarize_version_closeout: "66ec9c27dce60e1c53e16f8dbea8b45013b0e79ee74cb359bd29ee4480e657c4",
  plan_version_closeout: "08bf4d1b2980c928bbf05c6d573263b30e0da0be711b0f8a97c5525e4de2d16c",
  list_versions_window: "c40ea761829df3828b19e2a0fbfd6762890b4430a61c952add2ef8fcc814fe47",
  list_versions: "480db027872daaa23e514025f6de89f52ab5b7e4ceedda85a82d9746288785d9",
  check_start_gate: "a9542c5ef093c5388343fc7b93aa73a0a0cdb6c19336019612063e6fc1f59596",
  check_close_gate: "90b680739c328205e93ba3cf0ff72cedb13cce4e76104b5a4569cdc9917758f6",
  get_version_structure: "855d7bd3f338acf19de2fff94f7686a6c242bc8935845d65927855b2cfa1263e",
  get_version_transition_guide: "9fb74594bf4b8b44c878aa90c2ed45880f93abf6e26e3fd9f50a0ba7464deabf",
  recommend_l3_authorization_policy: "29d6aa2d56650582026660cf00531373ad6faa3596b65d3630d8d92ce72f1c9f",
  list_l3_proposals: "166213f9bbec88e1a35ce92b5376c93170370af0d67388847e3f5d79e4b8838d",
  get_l3_proposal: "a0aedcb4c5e004650c9f4be127292aa3310e752de41a48151f8a2713e93b5434",
  batch_create_versions: "5fee13a0fe31a90a51af668ef9cbe5761b54613e113c2a730e26f27c839b0b28",
  transition_version: "3f043ea5340c8a8be716d468a5a455d49d8182165af61d6e620fd39f65309d18",
  advance_to_version: "e1452462673afd76fbbb58c3bff562a245c1ef343cd25fad56754cba2930b947",
  close_version: "f20a5ecdc38118df5b5cc4c201fee6cb139b7fa4f50a1b2eb3a2b0fdfbf56e8e",
  shutdown_version: "d94d76b1a65dc9a4790ba42400713ef58e55b3efdcacf813d9c710f69bb55c47",
  create_todo: "764a2d9995a91ea4002d6447d99e9bfd6cb150292f6b09dd3c2ad9f65175a3c8",
  close_todo: "9b75194736a9e2a129ace7baffda6059ee2d663b8fa721c85abef2c1c6d79105",
  defer_work: "26a7f058a60744506767821d8556fe289ab29dc715f81483f77cd4b416095f11",
  review_deferred: "08a8a3c00cabcd72cd802233e4da9fb11bc8e762666c1581f975c37332d2a478",
  record_constraint: "06eae2ba1d96e0b20b089d2a74c81abde1fd11bff7fdb55047bf9161777db90f",
  retire_constraint: "2259c47a2f987daa3a5072933d48ffbea6fb286a14a5c6be091de133fd0a2dc5",
  prepare_version: "0f9d1e7ab1dc22349ed9f7b0bf028e9dbb39f74e0c1f9c341ef6cd2e518bbb57",
  mark_version_complete: "b06f40659efb3cc29f0ece168e1a805910475bf83cf99c74820a0435b6c07632",
  create_version: "9451200f504914cec1397a994d52d10ce33db133111c3c25166cf91aa240abfc",
  insert_version: "98dfca2d5ce1fafb3b1ccb07cfb4be52a9353498a638f0aac37e3a46315068a9",
  create_child_version: "ef3794112ceea8ef6bf7ebf3823ccff5486d707ccb0840d637497fcadaad4eac",
  reorder_versions: "b4658ec764e4a65aa90f464742d8599010923080e1c3b309474762bad5f4daec",
  propose_l3_operation: "539422107c5281075c037aee09d5eba5ee93612d8da05c8d1cb333a24288e540",
  execute_l3_operation: "a39420cc1d8c96860b013e5d9dda04f4d5ee681ba940d125b9170d9dd37db81f",
  approve_l3_operation: "83adb2fb39b423d2ddc6dd08c60bb45abca119773228381e64ac6df75b12648a",
  commit_l3_operation: "fcbb42557fb8ea8812012b2c8e6a3fa71e687bcbbe62aa61b75567ea1f782244",
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

      expect(tools).toHaveLength(48);
      expect(readOnly).toHaveLength(22);
      expect(writes).toHaveLength(21);
      expect(highRisk).toHaveLength(5);
      expect(writes.concat(highRisk)).toHaveLength(26);
      for (const tool of writes.concat(highRisk)) {
        const required = (tool.inputSchema.required ?? []) as string[];
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
        expect(properties).toHaveProperty("expectedRouteLedgerRoot");
        expect(required).not.toContain("expectedRouteLedgerRoot");
      }
      for (const name of ["transition_version", "close_version", "shutdown_version"]) {
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
      expect(descriptions.reduce((total, description) => total + description.length, 0)).toBeLessThanOrEqual(3400);
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

  it("keeps close residual-audit schemas free of the removed legacy create_undo routing", () => {
    const registry = createRouteLedgerMcpRegistry({});

    try {
      const closeVersion = getTool(registry.tools, "close_version");
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
            "close_version",
            "defer_work",
            "create_version",
            "commit_l3_operation"
          ].map((name) => [name, getTool(registry.tools, name).description])
        )
      ).toMatchInlineSnapshot(`
        {
          "activate_routeledger_binding": "Activate an explicit MCP binding. Input: workspaceRoot. Warning: switching an established Codex session requires confirmProjectSwitch=true.",
          "close_version": "Binding-sensitive close preview or proposal. Input: mode and versionId. Warning: proposal needs a passing gate.",
          "commit_l3_operation": "Commit an approved L3 proposal. Input: pendingOperationId and approvalArtifactId. Warning: consumes once; exact retries replay.",
          "create_version": "Propose a top-level version, including append-only continuation after a closed top-level tail. Warning: returns a pending L3 operation.",
          "defer_work": "Create Deferred work for a future review. Input: mode, targetReviewVersionId, and Todo or new-work fields.",
          "get_current_context": "Read current project, route, work, and gate context.",
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
