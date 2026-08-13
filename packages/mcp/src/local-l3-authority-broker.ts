import fs from "node:fs/promises";
import path from "node:path";

import {
  digestL3AuthorizationProfile,
  validateL3AuthorizationProfile,
  type L3AuthorizationPolicy,
  type L3AuthorizationProfileV2,
  type ExactAuthorizationStore
} from "@routeledger/core";

import {
  loadLocalL3AuthorityProfileRuntime,
  type LocalL3AuthorityStateTestHooks
} from "./local-l3-authorization.js";
import {
  loadLocalL3AuthorityProfileRegistry,
  installLocalL3AuthorizationProfile,
  buildLocalL3AuthorityBindingIdentity,
  buildLocalL3AuthorityBindingKey,
  type LocalL3AuthorityBindingInput
} from "./local-l3-authority-registry.js";
import type { RouteLedgerMcpDelegatedAuthorizationAuthority } from "./l3-authorization-contract.js";

export interface LocalL3AuthorityBrokerOptions {
  registryRoot: string;
  hostKind: string;
  subjectId: string;
  trustedClientId: string | null;
  trustedHostInteraction?: LocalL3AuthorityHostInteraction;
  /** @internal Test-only hooks for the persistent authority state. */
  testHooks?: LocalL3AuthorityStateTestHooks;
}

export interface LocalL3AuthorityHostDecision {
  kind: "trusted_host_user";
  decisionId: string;
  decidedAt: string;
}

export interface LocalL3AuthorityHostInteraction {
  requestDecision(request: {
    kind: "install_profile" | "configure_standing_policy";
    bindingKey: string;
    profileId: string;
    profileDigest: string;
    canonicalSummary: Readonly<Record<string, unknown>>;
  }): Promise<LocalL3AuthorityHostDecision>;
}

export interface ConfigureLocalL3StandingPolicyInput {
  binding: Omit<LocalL3AuthorityBindingInput, "hostKind" | "subjectId" | "trustedClientId">;
  policy: L3AuthorizationPolicy;
  expectedProfileRevision: number;
}

export interface BoundLocalL3Authority {
  bindingKey: string;
  profile: L3AuthorizationProfileV2;
  exactStore: ExactAuthorizationStore;
  trustedClientId?: string;
  delegatedAuthority?: RouteLedgerMcpDelegatedAuthorizationAuthority;
}

export interface LocalL3AuthorityBroker {
  readonly identity: {
    hostKind: string;
    subjectId: string;
    trustedClientId: string | null;
  };
  bind(
    input: Omit<LocalL3AuthorityBindingInput, "hostKind" | "subjectId" | "trustedClientId">
  ): Promise<BoundLocalL3Authority | null>;
  installProfile(input: {
    binding: Omit<LocalL3AuthorityBindingInput, "hostKind" | "subjectId" | "trustedClientId">;
    profile: L3AuthorizationProfileV2;
    expectedProfileRevision?: number;
  }): Promise<BoundLocalL3Authority>;
  configureStandingPolicy(
    input: ConfigureLocalL3StandingPolicyInput
  ): Promise<BoundLocalL3Authority>;
  revokeAccess(input: {
    binding: Omit<LocalL3AuthorityBindingInput, "hostKind" | "subjectId" | "trustedClientId">;
    expectedProfileRevision: number;
  }): Promise<BoundLocalL3Authority>;
}

const requireTrustedDecision = async (
  interaction: LocalL3AuthorityHostInteraction | undefined,
  request: Parameters<LocalL3AuthorityHostInteraction["requestDecision"]>[0]
): Promise<LocalL3AuthorityHostDecision> => {
  if (interaction === undefined) {
    throw new Error("A trusted host user-interaction adapter is required for this authority expansion.");
  }
  const decision = await interaction.requestDecision(request);
  if (
    decision.kind !== "trusted_host_user" ||
    decision.decisionId.trim().length === 0 ||
    Number.isNaN(Date.parse(decision.decidedAt))
  ) {
    throw new Error("The trusted host returned an invalid user decision.");
  }
  return decision;
};

export const createLocalL3AuthorityBroker = (
  options: LocalL3AuthorityBrokerOptions
): LocalL3AuthorityBroker => {
  const trustedBinding = (
    input: Omit<LocalL3AuthorityBindingInput, "hostKind" | "subjectId" | "trustedClientId">
  ): LocalL3AuthorityBindingInput => ({
    ...input,
    hostKind: options.hostKind,
    subjectId: options.subjectId,
    trustedClientId: options.trustedClientId
  });
  const bind = async (
    input: Omit<LocalL3AuthorityBindingInput, "hostKind" | "subjectId" | "trustedClientId">
  ): Promise<BoundLocalL3Authority | null> => {
    const binding: LocalL3AuthorityBindingInput = {
      ...trustedBinding(input)
    };
    const registry = await loadLocalL3AuthorityProfileRegistry({
      registryRoot: options.registryRoot,
      workspaceRoot: input.workspaceRoot,
      routeledgerRoot: input.routeledgerRoot
    });
    const selected = await registry.bind(binding);
    if (selected === null) return null;
    const registryRoot = await fs.realpath(options.registryRoot);
    const runtime = await loadLocalL3AuthorityProfileRuntime({
      profile: selected.profile,
      statePath: path.join(registryRoot, "bindings", selected.bindingKey, "state.json"),
      workspaceRoot: input.workspaceRoot,
      routeledgerRoot: input.routeledgerRoot,
      hostKind: options.hostKind,
      subjectId: options.subjectId,
      testHooks: options.testHooks
    });
    return {
      bindingKey: selected.bindingKey,
      profile: runtime.profile,
      exactStore: runtime.exactStore,
      ...(runtime.trustedClientId === undefined
        ? {}
        : { trustedClientId: runtime.trustedClientId }),
      ...(runtime.delegatedAuthority === undefined
        ? {}
        : { delegatedAuthority: runtime.delegatedAuthority })
    };
  };
  return {
    identity: {
      hostKind: options.hostKind,
      subjectId: options.subjectId,
      trustedClientId: options.trustedClientId
    },
    bind,
    installProfile: async (input) => {
      const binding = trustedBinding(input.binding);
      const identity = await buildLocalL3AuthorityBindingIdentity(binding);
      if (JSON.stringify(input.profile.binding) !== JSON.stringify(identity)) {
        throw new Error("Local L3 authorization profile binding does not match the verified project binding.");
      }
      const validation = validateL3AuthorizationProfile(input.profile);
      if (!validation.valid) {
        throw new Error(`Local L3 authorization profile is invalid: ${validation.issues[0]?.code ?? "UNKNOWN"}.`);
      }
      const bindingKey = buildLocalL3AuthorityBindingKey(identity);
      await requireTrustedDecision(options.trustedHostInteraction, {
        kind: "install_profile",
        bindingKey,
        profileId: input.profile.profileId,
        profileDigest: input.profile.profileDigest,
        canonicalSummary: {
          status: input.profile.status,
          mode: input.profile.mode,
          modeEpoch: input.profile.modeEpoch,
          limits: input.profile.limits,
          delegatedPolicyId: input.profile.delegatedPolicy?.policyId ?? null
        }
      });
      await installLocalL3AuthorizationProfile({
        registryRoot: options.registryRoot,
        workspaceRoot: input.binding.workspaceRoot,
        routeledgerRoot: input.binding.routeledgerRoot,
        binding,
        profile: input.profile,
        ...(input.expectedProfileRevision === undefined
          ? {}
          : { expectedProfileRevision: input.expectedProfileRevision })
      });
      const selected = await bind(input.binding);
      if (selected === null) throw new Error("The installed L3 authorization profile was not found.");
      return selected;
    },
    configureStandingPolicy: async (input) => {
      const selected = await bind(input.binding);
      if (
        selected === null ||
        selected.profile.status !== "active" ||
        selected.profile.mode !== "preauthorized"
      ) {
        throw new Error("An active preauthorized profile is required.");
      }
      if (selected.profile.profileRevision !== input.expectedProfileRevision) {
        throw new Error("Local L3 authorization profile revision conflict.");
      }
      const decision = await requireTrustedDecision(options.trustedHostInteraction, {
        kind: "configure_standing_policy",
        bindingKey: selected.bindingKey,
        profileId: selected.profile.profileId,
        profileDigest: selected.profile.profileDigest,
        canonicalSummary: {
          policyId: input.policy.policyId,
          policyMode: input.policy.mode,
          policyBinding: input.policy.binding,
          ruleIds: input.policy.rules.map((rule) => rule.id)
        }
      });
      const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
        ...selected.profile,
        modeEpoch: selected.profile.modeEpoch + 1,
        profileRevision: selected.profile.profileRevision + 1,
        delegatedPolicy: input.policy,
        updatedAt: decision.decidedAt
      };
      const profile = { ...base, profileDigest: digestL3AuthorizationProfile(base) };
      await installLocalL3AuthorizationProfile({
        registryRoot: options.registryRoot,
        workspaceRoot: input.binding.workspaceRoot,
        routeledgerRoot: input.binding.routeledgerRoot,
        binding: {
          projectId: input.binding.projectId,
          workspaceRoot: input.binding.workspaceRoot,
          routeledgerRoot: input.binding.routeledgerRoot,
          hostKind: options.hostKind,
          subjectId: options.subjectId,
          trustedClientId: options.trustedClientId
        },
        profile,
        expectedProfileRevision: input.expectedProfileRevision
      });
      const configured = await bind(input.binding);
      if (configured === null) throw new Error("The standing policy profile was not found.");
      return configured;
    },
    revokeAccess: async (input) => {
      const selected = await bind(input.binding);
      if (selected === null) throw new Error("No L3 authorization profile is installed for this binding.");
      if (selected.profile.profileRevision !== input.expectedProfileRevision) {
        throw new Error("Local L3 authorization profile revision conflict.");
      }
      const base: Omit<L3AuthorizationProfileV2, "profileDigest"> = {
        ...selected.profile,
        status: "disabled",
        modeEpoch: selected.profile.modeEpoch + 1,
        profileRevision: selected.profile.profileRevision + 1,
        updatedAt: new Date().toISOString()
      };
      const profile = { ...base, profileDigest: digestL3AuthorizationProfile(base) };
      await installLocalL3AuthorizationProfile({
        registryRoot: options.registryRoot,
        workspaceRoot: input.binding.workspaceRoot,
        routeledgerRoot: input.binding.routeledgerRoot,
        binding: trustedBinding(input.binding),
        profile,
        expectedProfileRevision: input.expectedProfileRevision
      });
      const revoked = await bind(input.binding);
      if (revoked === null) throw new Error("The revoked L3 authorization profile was not found.");
      return revoked;
    }
  };
};
