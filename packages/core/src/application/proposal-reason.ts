import type { PendingOperationReasonSource } from "./types.js";

export interface ResolvedProposalReason {
  reason: string;
  reasonSource: Exclude<PendingOperationReasonSource, "legacy_unspecified">;
}

export const resolveProposalReason = (
  explicitReason: string | undefined,
  systemDefault: string
): ResolvedProposalReason =>
  explicitReason === undefined
    ? { reason: systemDefault, reasonSource: "system_default" }
    : { reason: explicitReason, reasonSource: "explicit_input" };
