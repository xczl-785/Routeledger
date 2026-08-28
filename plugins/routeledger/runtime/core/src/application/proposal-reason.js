export const resolveProposalReason = (explicitReason, systemDefault) => explicitReason === undefined
    ? { reason: systemDefault, reasonSource: "system_default" }
    : { reason: explicitReason, reasonSource: "explicit_input" };
