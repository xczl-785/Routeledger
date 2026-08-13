import { createHash, randomUUID } from "node:crypto";

import {
  ApplicationError,
  BALANCED_ALWAYS_PROMPT_ACTIONS,
  BALANCED_AUTO_ACTIONS,
  createExactProposalDecisionRequest,
  digestL3AuthorizationPolicy,
  digestL3AuthorizationProfile,
  orchestrateL3Operation,
  projectDecisionArtifact,
  type Actor,
  type ExactAuthorizationBinding,
  type ExactAuthorizationStore,
  type L3ActionType,
  type L3AuthorizationProfileV2,
  type PendingOperation,
  type RouteLedgerService
} from "@routeledger/core";

import { CodexL3DecisionAdapter } from "../codex-l3-decision-adapter.js";
import {
  ExistingL3DecisionAdapter,
  requireResolvedExistingL3Decision
} from "../existing-l3-decision-adapter.js";
import { InvalidToolInputError } from "../input-adapter.js";
import type {
  RouteLedgerMcpAuthorizationInteraction,
  RouteLedgerMcpDelegatedAuthorizationAuthority
} from "../l3-authorization-contract.js";
import { residualAuditInputSchema } from "../registry/route-input-schemas.js";
import {
  defineTool,
  type ToolRegistration,
  type ToolResponse
} from "../registry/tool-contract.js";

type HostPermissionContext =
  | {
      status: "resolved";
      mode: "interactive" | "delegated" | "preauthorized";
      source: "codex_permission_profile" | "plugin_config";
      codexPermissionProfile: string | null;
      fallbackUsed: boolean;
    }
  | {
      status: "unavailable";
      code: string;
      codexPermissionProfile: string | null;
      reason: string;
    };

interface L3Options {
  l3AuthorityCandidateIdentity?: {
    subjectId: string;
    trustedClientId: string | null;
  };
  hostPermissionContext?: HostPermissionContext;
  l3Authorization?: {
    exactStore: ExactAuthorizationStore;
    interaction: RouteLedgerMcpAuthorizationInteraction;
    profile?: L3AuthorizationProfileV2;
    trustedClientId?: string;
    delegatedAuthority?: RouteLedgerMcpDelegatedAuthorizationAuthority;
  };
}

type DebugLogDraft = {
  type: string;
  projectId?: string;
  versionId?: string;
  pendingOperationId?: string;
  payload?: unknown;
};

type L3Service = Pick<
  RouteLedgerService,
  | "authorizeL3Operation"
  | "commitL3Operation"
  | "getL3AuthorizationEvaluationContext"
  | "getL3Proposal"
  | "listL3Proposals"
  | "proposeL3Operation"
  | "recommendBalancedL3AuthorizationPolicy"
  | "rejectL3Operation"
>;

export interface L3ToolDependencies {
  service: L3Service;
  actor: Actor;
  approver: Actor;
  hostProfile: string;
  initialBinding: { workspaceRoot: string | null; routeledgerRoot: string | null };
  options: L3Options;
  usesCodexNativeToolAdmission: boolean;
  digestAuthorizationPath: (candidate: string) => string;
  digestRouteLedgerRoot: (candidate: string) => string;
  appendDebugLog: (toolName: string, draft: DebugLogDraft) => Promise<void>;
}

const stringSchema = (description: string): Record<string, unknown> => ({
  type: "string",
  description
});
const integerSchema = (
  description: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({ type: "integer", description, ...extra });
const booleanSchema = (description: string): Record<string, unknown> => ({
  type: "boolean",
  description
});
const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type: "object",
  properties,
  additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  ...extra
});

const payloadSchema = objectSchema(
  {
    currentVersionId: {
      anyOf: [stringSchema("Optional current version override."), { type: "null" }]
    },
    fromVersionId: stringSchema("Expected current Version ID for advance_to_version."),
    residualAudit: { ...residualAuditInputSchema },
    title: stringSchema("Version title for create/insert/create-child proposals."),
    description: stringSchema(
      "Optional version description for create/insert/create-child proposals."
    ),
    parentVersionId: {
      anyOf: [
        stringSchema("Parent version ID used by create_child_version."),
        { type: "null" }
      ]
    },
    previousVersionId: {
      anyOf: [stringSchema("Previous sibling version ID anchor."), { type: "null" }]
    },
    nextVersionId: {
      anyOf: [stringSchema("Next sibling version ID anchor."), { type: "null" }]
    }
  },
  [],
  { description: "Optional payload captured in an L3 proposal." }
);

const canonicalizeExecutionInput = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeExecutionInput);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeExecutionInput(item)])
    );
  }
  return value;
};

const digestExecutionInput = (value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeExecutionInput(value)))
    .digest("hex")}`;

const actionTypeSchema = {
  type: "string",
  enum: [
    "start_version",
    "close_version",
    "shutdown_version",
    "reopen_version",
    "set_current_version",
    "advance_to_version",
    "create_version",
    "insert_version",
    "create_child_version",
    "reorder_versions"
  ],
  description: "L3 action type."
};

export const createL3AuthorizationTools = (
  dependencies: L3ToolDependencies
): ToolRegistration[] => {
  const {
    service,
    approver,
    hostProfile,
    initialBinding,
    options,
    usesCodexNativeToolAdmission,
    digestAuthorizationPath,
    digestRouteLedgerRoot
  } = dependencies;

  return [
    defineTool(
      "get_l3_authorization_status",
      { what: "Inspect active L3 authorization." },
      objectSchema({
        detail: {
          type: "string",
          enum: ["summary", "internal"],
          description: "Use internal only for host diagnostics; summary is the product default."
        }
      }),
      { title: "Get L3 Authorization Status", riskLevel: "read-only" },
      async (input) => {
        const profile = options.l3Authorization?.profile;
        const profileCompatible =
          options.hostPermissionContext?.status === "resolved" && profile !== undefined
            ? profile.mode === options.hostPermissionContext.mode
            : null;
        const effectiveMode =
          options.hostPermissionContext?.status === "resolved"
            ? {
                mode: options.hostPermissionContext.mode,
                source: options.hostPermissionContext.source,
                codexPermissionProfile:
                  options.hostPermissionContext.codexPermissionProfile,
                fallbackUsed: options.hostPermissionContext.fallbackUsed,
                profileCompatible
              }
            : usesCodexNativeToolAdmission
              ? {
                  status: "host_managed",
                  mode: null,
                  source: "codex_native_tool_admission",
                  codexPermissionProfile: null,
                  fallbackUsed: false,
                  profileCompatible,
                  reason:
                    "Codex enforces the active task permission before this high-risk tool call reaches RouteLedger."
                }
              : options.hostPermissionContext ?? null;
        const compatibilityBackend =
          options.l3AuthorityCandidateIdentity !== undefined || profile !== undefined
            ? "host_authority_broker_v2"
            : usesCodexNativeToolAdmission
              ? "exact_authorization_receipt"
              : options.l3Authorization === undefined
                ? "unavailable"
                : "v1_compatibility";
        const controlPlane =
          options.l3AuthorityCandidateIdentity !== undefined || profile !== undefined
            ? "host_authority_broker_v2"
            : usesCodexNativeToolAdmission
              ? "codex_native_tool_admission_v2"
              : compatibilityBackend;
        return {
          ok: true,
          data:
            profile === undefined
              ? {
                  controlPlane,
                  authorizationBackend: compatibilityBackend,
                  profile: null,
                  profileCompatible,
                  effectiveMode,
                  management: "host_only",
                  recommendedNextActions: []
                }
              : {
                  controlPlane: "host_authority_broker_v2",
                  authorizationBackend: "host_authority_broker_v2",
                  effectiveMode,
                  profileCompatible,
                  profile: {
                    status: profile.status,
                    mode: profile.mode,
                    limits: profile.limits,
                    delegatedPolicy:
                      profile.delegatedPolicy === null
                        ? null
                        : {
                            policyId: profile.delegatedPolicy.policyId,
                            policyDigest: digestL3AuthorizationPolicy(
                              profile.delegatedPolicy
                            ),
                            defaultEffect: profile.delegatedPolicy.defaultEffect,
                            ruleCount: profile.delegatedPolicy.rules.length,
                            alwaysPrompt: profile.delegatedPolicy.alwaysPrompt
                          },
                    ...(input.detail === "internal"
                      ? {
                          internal: {
                            profileId: profile.profileId,
                            modeEpoch: profile.modeEpoch,
                            profileRevision: profile.profileRevision,
                            profileDigest: profile.profileDigest
                          }
                        }
                      : {})
                  },
                  management: "host_only",
                  trustedUserDecisionProvenance: "required"
                }
        };
      }
    ),
    defineTool(
      "recommend_l3_authorization_profile",
      { what: "Build a conservative V3 profile candidate.", warning: "candidate only" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          mode: {
            type: "string",
            enum: ["interactive", "delegated", "preauthorized"],
            description: "Requested mutually exclusive authorization mode."
          },
          expiresInHours: integerSchema(
            "Delegated policy lifetime in hours. Defaults to 24.",
            { minimum: 1, maximum: 168 }
          ),
          decisionBudget: integerSchema(
            "Maximum exact decisions allowed by the standing policy. Defaults to 16.",
            { minimum: 1, maximum: 100 }
          ),
          maxAuthorizationTtlSeconds: integerSchema(
            "Maximum exact-authorization validity. Defaults to 3600 seconds.",
            { minimum: 30, maximum: 86400 }
          )
        },
        ["projectId", "mode"]
      ),
      { title: "Recommend L3 Authorization Profile", riskLevel: "read-only" },
      async (input) => {
        const mode = input.mode as L3AuthorizationProfileV2["mode"];
        const now = new Date();
        const decisionBudget = input.decisionBudget ?? 16;
        const binding = {
          projectId: input.projectId,
          workspaceRootDigest: digestAuthorizationPath(initialBinding.workspaceRoot!),
          routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot!),
          subjectId: options.l3AuthorityCandidateIdentity?.subjectId ?? approver.id,
          hostKind: hostProfile,
          trustedClientId:
            options.l3AuthorityCandidateIdentity?.trustedClientId ??
            options.l3Authorization?.trustedClientId ??
            null
        };
        const delegatedPolicy =
          mode === "delegated"
            ? await service.recommendBalancedL3AuthorizationPolicy({
                projectId: input.projectId,
                policyId: `balanced-${input.projectId}-${Date.now()}`,
                routeledgerRootDigest: binding.routeledgerRootDigest,
                expiresAt: new Date(
                  now.getTime() + (input.expiresInHours ?? 24) * 60 * 60 * 1000
                ).toISOString(),
                decisionBudget,
                subjectId: approver.id,
                hostKind: hostProfile,
                ...(binding.trustedClientId === null
                  ? {}
                  : { clientId: binding.trustedClientId })
              })
            : null;
        const profileBase: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
          schemaVersion: 3,
          profileId: `profile-${input.projectId}-${randomUUID()}`,
          status: "active",
          binding,
          mode,
          modeEpoch: 1,
          profileRevision: 1,
          delegatedPolicy,
          limits: {
            maxAuthorizationTtlSeconds: input.maxAuthorizationTtlSeconds ?? 3600
          },
          createdAt: now.toISOString(),
          updatedAt: now.toISOString()
        };
        return {
          ok: true,
          data: {
            candidateOnly: true,
            profile: {
              ...profileBase,
              profileDigest: digestL3AuthorizationProfile(profileBase)
            },
            recommendedChecklist: [
              "Verify project, workspace-root, RouteLedger-root, subject, host, and trusted-client bindings.",
              "Keep target IDs explicit; do not add wildcard targets.",
              "Keep credential validity and per-proposal decision budgets finite.",
              "Treat a mode or policy-capability expansion as a new trusted-host user decision.",
              "Install only through the host authority broker; project files and MCP tools are not authority."
            ]
          }
        };
      }
    )
  ];
};

export const createL3ProposalTools = (
  dependencies: L3ToolDependencies
): ToolRegistration[] => {
  const {
    service,
    approver,
    hostProfile,
    initialBinding,
    options,
    digestRouteLedgerRoot
  } = dependencies;

  return [
    defineTool(
      "recommend_l3_authorization_policy",
      { what: "Build a bound conservative L3 policy candidate." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          expiresInHours: integerSchema(
            "Policy lifetime in hours. Defaults to 24.",
            { minimum: 1, maximum: 168 }
          ),
          decisionBudget: integerSchema(
            "Maximum exact decisions per standing-policy rule. Defaults to 16.",
            { minimum: 1, maximum: 100 }
          )
        },
        ["projectId"]
      ),
      { title: "Recommend L3 Authorization Policy", riskLevel: "read-only" },
      async (input) => {
        const expiresInHours = input.expiresInHours ?? 24;
        const decisionBudget = input.decisionBudget ?? 16;
        const policy = await service.recommendBalancedL3AuthorizationPolicy({
          projectId: input.projectId,
          policyId: `balanced-${input.projectId}-${Date.now()}`,
          routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot!),
          expiresAt: new Date(
            Date.now() + expiresInHours * 60 * 60 * 1000
          ).toISOString(),
          decisionBudget,
          subjectId: approver.id,
          hostKind: hostProfile,
          ...(options.l3Authorization?.trustedClientId === undefined
            ? {}
            : { clientId: options.l3Authorization.trustedClientId })
        });
        return {
          ok: true,
          data: {
            policy,
            candidateOnly: true,
            authorityPlacement: "host_managed_outside_agent_write_scope",
            injectionContract: "RouteLedgerMcpDelegatedAuthorizationAuthority",
            installationContract: {
              configSchemaVersion: 1,
              trustedHostApi: "installLocalL3AuthorityConfig",
              runtimeOption: "--l3-authority-config",
              requiredHostInputs: [
                "absolute configPath outside workspace and RouteLedger root",
                "absolute statePath outside workspace and RouteLedger root",
                "explicit user confirmation of the reviewed candidate"
              ],
              agentCanInstall: false
            },
            coverage: {
              delegatedWhenLiveGatePasses: [...BALANCED_AUTO_ACTIONS],
              alwaysPrompt: [...BALANCED_ALWAYS_PROMPT_ACTIONS],
              unmatchedAction: policy.defaultEffect
            },
            reviewChecklist: [
              "Verify the project and RouteLedger-root bindings.",
              "Verify the current-version and target list snapshot.",
              "Choose credential validity and a per-proposal decision budget.",
              "Keep shutdown, reopen, route editing, and current-pointer changes in alwaysPrompt.",
              "Install only in a host-managed authority and inject its opaque handle at MCP startup; never save this candidate as project authority."
            ]
          }
        };
      }
    ),
    defineTool(
      "list_l3_proposals",
      { what: "List pending and historical L3 proposals." },
      objectSchema({ projectId: stringSchema("RouteLedger project ID.") }, [
        "projectId"
      ]),
      { title: "List L3 Proposals", riskLevel: "read-only" },
      async (input) => ({
        ok: true,
        data: await service.listL3Proposals(input.projectId)
      })
    ),
    defineTool(
      "get_l3_proposal",
      { what: "Read one L3 proposal." },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          pendingOperationId: stringSchema("Pending operation ID.")
        },
        ["projectId", "pendingOperationId"]
      ),
      { title: "Get L3 Proposal", riskLevel: "read-only" },
      async (input) => ({
        ok: true,
        data: await service.getL3Proposal(input.projectId, input.pendingOperationId)
      })
    )
  ];
};

const createL3DecisionAdapter = (
  dependencies: L3ToolDependencies,
  proposal: Readonly<PendingOperation>
) => {
  const {
    service,
    approver,
    hostProfile,
    initialBinding,
    options,
    usesCodexNativeToolAdmission,
    digestRouteLedgerRoot
  } = dependencies;
  if (options.l3Authorization === undefined) {
    throw new ApplicationError(
      "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
      "This MCP connection has no trusted L3 authorization control plane",
      { pendingOperationId: proposal.id }
    );
  }
  const l3Authorization = options.l3Authorization;
  const activeProfile = l3Authorization.profile;
  if (
    hostProfile === "codex" &&
    options.hostPermissionContext?.status === "resolved" &&
    activeProfile !== undefined &&
    activeProfile.mode !== options.hostPermissionContext.mode
  ) {
    throw new ApplicationError(
      "AUTHORIZATION_PROFILE_DISABLED",
      "The bound RouteLedger authorization profile does not match the effective Codex permission mode",
      {
        reason: "CODEX_ROUTELEDGER_MODE_MISMATCH",
        effectiveMode: options.hostPermissionContext.mode,
        configuredMode: activeProfile.mode,
        profileId: activeProfile.profileId
      }
    );
  }
  if (activeProfile?.status === "disabled") {
    throw new ApplicationError(
      "AUTHORIZATION_PROFILE_DISABLED",
      "The bound L3 authorization profile is disabled",
      { profileId: activeProfile.profileId, modeEpoch: activeProfile.modeEpoch }
    );
  }
  const authorizationContext = {
    audience: "routeledger-core",
    subjectId: approver.id,
    projectId: proposal.projectId,
    routeledgerRootDigest: digestRouteLedgerRoot(initialBinding.routeledgerRoot!),
    ...(activeProfile === undefined
      ? {}
      : {
          profileId: activeProfile.profileId,
          modeEpoch: activeProfile.modeEpoch,
          profileDigest: activeProfile.profileDigest
        }),
    actionType: proposal.actionType,
    targetId: proposal.targetId,
    operationDigest: proposal.digest.value,
    now: new Date().toISOString(),
    hostKind: hostProfile,
    ...(l3Authorization.trustedClientId === undefined
      ? {}
      : { clientId: l3Authorization.trustedClientId })
  };
  if (usesCodexNativeToolAdmission) {
    return new CodexL3DecisionAdapter({
      authorizationContext,
      exactStore: l3Authorization.exactStore
    });
  }
  return new ExistingL3DecisionAdapter({
    proposal,
    authorizationContext,
    exactStore: l3Authorization.exactStore,
    interaction: l3Authorization.interaction,
    hostProfile,
    ...(l3Authorization.trustedClientId === undefined
      ? {}
      : { trustedClientId: l3Authorization.trustedClientId }),
    ...(activeProfile === undefined ? {} : { profile: activeProfile }),
    ...(l3Authorization.delegatedAuthority === undefined
      ? {}
      : { delegatedAuthority: l3Authorization.delegatedAuthority }),
    getEvaluationContext: () =>
      service.getL3AuthorizationEvaluationContext({
        projectId: proposal.projectId,
        pendingOperationId: proposal.id,
        routeledgerRootDigest: authorizationContext.routeledgerRootDigest,
        ...(activeProfile === undefined
          ? {}
          : {
              profileId: activeProfile.profileId,
              modeEpoch: activeProfile.modeEpoch,
              profileDigest: activeProfile.profileDigest
            }),
        subjectId: approver.id,
        hostKind: hostProfile,
        ...(l3Authorization.trustedClientId === undefined
          ? {}
          : { clientId: l3Authorization.trustedClientId })
      })
  });
};

const executeExistingL3Proposal = async (
  dependencies: L3ToolDependencies,
  proposal: Readonly<PendingOperation>,
  idempotencyKey: string
): Promise<ToolResponse> => {
  const { service, actor, appendDebugLog } = dependencies;
  if (proposal.status === "committed" && proposal.approvalArtifactId !== null) {
    const committed = await service.commitL3Operation({
      projectId: proposal.projectId,
      pendingOperationId: proposal.id,
      approvalArtifactId: proposal.approvalArtifactId,
      actor
    });
    return {
      ok: true,
      data: {
        status: "committed",
        proposalId: proposal.id,
        decisionArtifact: projectDecisionArtifact(committed.approvalArtifact),
        commit: committed
      }
    };
  }
  if (proposal.status === "rejected") {
    return {
      ok: true,
      data: {
        status: "denied",
        proposalId: proposal.id,
        code: "PREVIOUSLY_REJECTED",
        reason: proposal.rejectionReason,
        rejection: proposal
      }
    };
  }
  const result = await orchestrateL3Operation({
    proposal,
    adapter: createL3DecisionAdapter(dependencies, proposal),
    port: {
      authorize: async (_proposal, decision) => {
        if (decision.authorizationId === undefined) {
          throw new ApplicationError(
            "EXACT_AUTHORIZATION_REJECTED",
            "The resolved L3 decision has no exact authorization",
            { pendingOperationId: proposal.id, reason: "AUTHORIZATION_ID_REQUIRED" }
          );
        }
        return service.authorizeL3Operation({
          projectId: proposal.projectId,
          pendingOperationId: proposal.id,
          authorizationId: decision.authorizationId,
          actor
        });
      },
      commit: (_proposal, artifact) =>
        service.commitL3Operation({
          projectId: proposal.projectId,
          pendingOperationId: proposal.id,
          approvalArtifactId: artifact.id,
          actor
        }),
      reject: (_proposal, denial) =>
        service.rejectL3Operation({
          projectId: proposal.projectId,
          pendingOperationId: proposal.id,
          reason: `${denial.code}: ${denial.reason}`,
          actor
        })
    }
  });
  if (result.status === "committed") {
    await appendDebugLog("execute_l3_operation", {
      type: "l3.commit",
      projectId: proposal.projectId,
      versionId: proposal.targetId,
      pendingOperationId: proposal.id,
      payload: {
        actionType: proposal.actionType,
        approvalArtifactId: result.approvalArtifact.id,
        replayed: result.commit.replayed,
        idempotencyKey
      }
    });
  }
  return {
    ok: true,
    data:
      result.status === "committed"
        ? {
            status: result.status,
            proposalId: result.proposalId,
            decision: result.decision,
            decisionArtifact: projectDecisionArtifact(result.approvalArtifact),
            commit: result.commit
          }
        : result
  };
};

export const createL3OperationTools = (
  dependencies: L3ToolDependencies
): ToolRegistration[] => {
  const { service, actor, hostProfile, initialBinding, options, digestRouteLedgerRoot, appendDebugLog } = dependencies;
  const executionRequests = new Map<
    string,
    { fingerprint: string; proposalId: Promise<string>; inFlight?: Promise<ToolResponse> }
  >();
  return [
    defineTool(
      "propose_l3_operation",
      {
        what: "Create a pending L3 proposal.",
        parameter: "actionType, targetId, and reason"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          actionType: actionTypeSchema,
          targetId: stringSchema("Target record ID."),
          reason: stringSchema("Proposal reason."),
          payload: payloadSchema
        },
        ["projectId", "actionType", "targetId", "reason"]
      ),
      { title: "Propose L3 Operation", riskLevel: "write" },
      async (input) => ({
        ok: true,
        data: await service.proposeL3Operation({
          projectId: input.projectId,
          actionType: input.actionType as L3ActionType,
          targetId: input.targetId,
          reason: input.reason,
          payload: input.payload ?? {},
          actor
        })
      })
    ),
    defineTool(
      "execute_l3_operation",
      {
        what: "Execute one exact L3 operation end to end.",
        parameter: "action, target, reason, and idempotency key",
        warning: "key reuse requires the same input"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          actionType: actionTypeSchema,
          targetId: stringSchema("Target record ID."),
          reason: stringSchema("Proposal reason."),
          idempotencyKey: stringSchema(
            "Caller-stable key for exact retry within this MCP registry lifetime."
          ),
          payload: payloadSchema
        },
        ["projectId", "actionType", "targetId", "reason", "idempotencyKey"]
      ),
      {
        title: "Execute L3 Operation",
        riskLevel: "high-risk",
        destructive: true,
        idempotent: true,
        recommendedApprovalMode: "approve"
      },
      async (input) => {
        if (options.l3Authorization === undefined) {
          throw new ApplicationError(
            "AUTHORIZATION_CONTROL_PLANE_UNAVAILABLE",
            "This MCP connection has no trusted L3 authorization control plane"
          );
        }
        if (options.l3Authorization.profile?.status === "disabled") {
          throw new ApplicationError(
            "AUTHORIZATION_PROFILE_DISABLED",
            "The bound L3 authorization profile is disabled",
            {
              profileId: options.l3Authorization.profile.profileId,
              modeEpoch: options.l3Authorization.profile.modeEpoch
            }
          );
        }
        if (
          hostProfile === "codex" &&
          options.hostPermissionContext?.status === "resolved" &&
          options.l3Authorization.profile !== undefined &&
          options.l3Authorization.profile.mode !== options.hostPermissionContext.mode
        ) {
          throw new ApplicationError(
            "AUTHORIZATION_PROFILE_DISABLED",
            "The bound RouteLedger authorization profile does not match the effective Codex permission mode",
            {
              reason: "CODEX_ROUTELEDGER_MODE_MISMATCH",
              effectiveMode: options.hostPermissionContext.mode,
              configuredMode: options.l3Authorization.profile.mode
            }
          );
        }
        if (input.idempotencyKey.trim().length === 0) {
          throw new InvalidToolInputError("idempotencyKey must be non-empty", {
            toolName: "execute_l3_operation",
            path: "$.idempotencyKey",
            expected: "non-empty string"
          });
        }
        const exactInput = {
          projectId: input.projectId,
          actionType: input.actionType,
          targetId: input.targetId,
          reason: input.reason,
          payload: input.payload ?? {}
        };
        const fingerprint = digestExecutionInput(exactInput);
        const existing = executionRequests.get(input.idempotencyKey);
        if (existing !== undefined && existing.fingerprint !== fingerprint) {
          throw new InvalidToolInputError(
            "idempotencyKey is already bound to a different L3 execution request",
            {
              toolName: "execute_l3_operation",
              path: "$.idempotencyKey",
              reason: "IDEMPOTENCY_KEY_REUSE_MISMATCH",
              idempotencyKey: input.idempotencyKey
            }
          );
        }
        let entry = existing;
        if (entry === undefined) {
          const resumeProposalId = (input as Record<string, unknown>)[
            "__routeledgerMcpResumeProposalId"
          ];
          const proposalId =
            typeof resumeProposalId === "string" && resumeProposalId.trim().length > 0
              ? Promise.resolve(resumeProposalId)
              : service
                  .proposeL3Operation({
                    ...exactInput,
                    actionType: input.actionType as L3ActionType,
                    actor
                  })
                  .then((proposal) => proposal.id);
          entry = { fingerprint, proposalId };
          executionRequests.set(input.idempotencyKey, entry);
          proposalId.catch(() => {
            if (executionRequests.get(input.idempotencyKey) === entry) {
              executionRequests.delete(input.idempotencyKey);
            }
          });
        }
        const pendingOperationId = await entry.proposalId;
        const proposal = await service.getL3Proposal(input.projectId, pendingOperationId);
        const resumeBinding = (input as Record<string, unknown>)[
          "__routeledgerMcpResumeBinding"
        ] as Partial<ExactAuthorizationBinding> | undefined;
        if (
          resumeBinding !== undefined &&
          (resumeBinding.proposalId !== proposal.id ||
            resumeBinding.projectId !== proposal.projectId ||
            resumeBinding.routeledgerRootDigest !==
              digestRouteLedgerRoot(initialBinding.routeledgerRoot!) ||
            resumeBinding.actionType !== proposal.actionType ||
            resumeBinding.targetId !== proposal.targetId ||
            resumeBinding.operationDigest !== proposal.digest.value)
        ) {
          throw new InvalidToolInputError(
            "requestState no longer matches the live exact proposal",
            {
              toolName: "execute_l3_operation",
              path: "$._meta.requestState",
              reason: "REQUEST_STATE_LIVE_BINDING_MISMATCH",
              pendingOperationId
            }
          );
        }
        if (entry.inFlight === undefined) {
          entry.inFlight = executeExistingL3Proposal(
            dependencies,
            proposal,
            input.idempotencyKey
          );
        }
        const inFlight = entry.inFlight;
        try {
          return await inFlight;
        } finally {
          if (entry.inFlight === inFlight) delete entry.inFlight;
        }
      }
    ),
    defineTool(
      "approve_l3_operation",
      {
        what: "Authorize one pending L3 proposal.",
        parameter: "pendingOperationId",
        warning: "Codex gates this call; other hosts need trusted authority"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          pendingOperationId: stringSchema("Pending operation ID."),
          decisionRef: stringSchema(
            "Deprecated display-only input. It is ignored and cannot create authorization."
          )
        },
        ["projectId", "pendingOperationId"]
      ),
      { title: "Approve L3 Operation", riskLevel: "high-risk" },
      async (input) => {
        const proposal = await service.getL3Proposal(
          input.projectId,
          input.pendingOperationId
        );
        const adapter = createL3DecisionAdapter(dependencies, proposal);
        const resolution = await adapter.resolve(
          createExactProposalDecisionRequest(proposal)
        );
        if (
          resolution.status === "denied" &&
          "details" in resolution &&
          resolution.details.reason === "HOST_DECLINED"
        ) {
          await service.rejectL3Operation({
            projectId: proposal.projectId,
            pendingOperationId: proposal.id,
            reason: `${resolution.code}: ${resolution.reason}`,
            actor
          });
        }
        const decision = requireResolvedExistingL3Decision(resolution);
        if (decision.authorizationId === undefined) {
          throw new ApplicationError(
            "EXACT_AUTHORIZATION_REJECTED",
            "The resolved L3 decision has no exact authorization",
            { pendingOperationId: proposal.id, reason: "AUTHORIZATION_ID_REQUIRED" }
          );
        }
        return {
          ok: true,
          data: await service.authorizeL3Operation({
            projectId: input.projectId,
            pendingOperationId: input.pendingOperationId,
            authorizationId: decision.authorizationId,
            actor
          })
        };
      }
    ),
    defineTool(
      "commit_l3_operation",
      {
        what: "Commit an approved L3 proposal.",
        parameter: "pendingOperationId and approvalArtifactId",
        warning: "consumes once; exact retries replay"
      },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          pendingOperationId: stringSchema("Pending operation ID."),
          approvalArtifactId: stringSchema("Approval artifact ID."),
          confirm: booleanSchema(
            "Legacy boolean confirmation input. RouteLedger ignores confirm=true without an approval artifact."
          )
        },
        ["projectId", "pendingOperationId", "approvalArtifactId"]
      ),
      {
        title: "Commit L3 Operation",
        riskLevel: "high-risk",
        destructive: true,
        recommendedApprovalMode: "approve"
      },
      async (input) => {
        const committed = await service.commitL3Operation({
          projectId: input.projectId,
          pendingOperationId: input.pendingOperationId,
          approvalArtifactId: input.approvalArtifactId,
          confirm: input.confirm,
          actor
        });
        await appendDebugLog("commit_l3_operation", {
          type: "l3.commit",
          projectId: input.projectId,
          versionId: committed.pendingOperation.targetId,
          pendingOperationId: committed.pendingOperation.id,
          payload: {
            actionType: committed.pendingOperation.actionType,
            pendingOperationStatus: committed.pendingOperation.status,
            approvalArtifactId: committed.approvalArtifact.id,
            approvalArtifactStatus: committed.approvalArtifact.status,
            replayed: committed.replayed
          }
        });
        return { ok: true, data: committed };
      }
    ),
    defineTool(
      "reject_l3_operation",
      { what: "Reject a pending L3 proposal.", warning: "requires a host decision" },
      objectSchema(
        {
          projectId: stringSchema("RouteLedger project ID."),
          pendingOperationId: stringSchema("Pending operation ID."),
          reason: stringSchema("Rejection reason.")
        },
        ["projectId", "pendingOperationId", "reason"]
      ),
      { title: "Reject L3 Operation", riskLevel: "high-risk" },
      async (input) => ({
        ok: true,
        data: await service.rejectL3Operation({
          projectId: input.projectId,
          pendingOperationId: input.pendingOperationId,
          reason: input.reason,
          actor
        })
      })
    )
  ];
};
