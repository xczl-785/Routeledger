export type RouteLedgerInteractionProfile =
  | "agent_only"
  | "agent_with_human_review"
  | "human_ui";

type HostProfile = "generic" | "codex" | "claude-code" | "cursor";

export const resolveInteractionProfile = (
  hostProfile: HostProfile,
  override?: RouteLedgerInteractionProfile
): RouteLedgerInteractionProfile =>
  override ?? (hostProfile === "generic" ? "agent_with_human_review" : "agent_only");
