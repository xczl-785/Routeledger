export const resolveInteractionProfile = (hostProfile, override) => override ?? (hostProfile === "generic" ? "agent_with_human_review" : "agent_only");
