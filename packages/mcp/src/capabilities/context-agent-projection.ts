const sanitizeLegacyGateBlockersForAgent = (
  blockers: unknown
): Array<Record<string, unknown>> =>
  (Array.isArray(blockers) ? blockers : []).map(
    (blocker: Record<string, unknown>) => {
      if (typeof blocker.code !== "string" || !blocker.code.includes("UNDO")) {
        return blocker;
      }

      return {
        code: "LEGACY_WORK_REQUIRES_AUDIT",
        message:
          "Legacy work blocks this operation; use get_current_context(projectId, includeLegacyUndo=true) for audit details.",
        recordCount: Array.isArray(blocker.recordIds) ? blocker.recordIds.length : 0
      };
    }
  );

const sanitizeVersionStructureOperationForAgent = (
  operation: Record<string, any>
): Record<string, unknown> => {
  const sanitized = structuredClone(operation) as Record<string, any>;
  sanitized.blockers = sanitizeLegacyGateBlockersForAgent(sanitized.blockers);

  if (sanitized.details !== null && typeof sanitized.details === "object") {
    const details = sanitized.details as Record<string, any>;

    if (Array.isArray(details.unresolvedUndoIds)) {
      details.legacyBlockerCount = details.unresolvedUndoIds.length;
      delete details.unresolvedUndoIds;
    }

    if (
      details.ordinaryCloseGate !== null &&
      typeof details.ordinaryCloseGate === "object"
    ) {
      const ordinaryCloseGate = details.ordinaryCloseGate as Record<string, any>;

      if (Array.isArray(ordinaryCloseGate.unresolvedUndoIds)) {
        ordinaryCloseGate.legacyBlockerCount = ordinaryCloseGate.unresolvedUndoIds.length;
        delete ordinaryCloseGate.unresolvedUndoIds;
      }

      if (Array.isArray(ordinaryCloseGate.blockerCodes)) {
        ordinaryCloseGate.blockerCodes = [
          ...new Set(
            ordinaryCloseGate.blockerCodes.map((code: unknown) =>
              typeof code === "string" && code.includes("UNDO")
                ? "LEGACY_WORK_REQUIRES_AUDIT"
                : code
            )
          )
        ];
      }
    }
  }

  return sanitized;
};

export const sanitizeVersionStructureForAgent = (
  structure: unknown
): Record<string, unknown> => {
  const sanitized = structuredClone(structure) as Record<string, any>;
  const operations = Array.isArray(sanitized.legalOperations)
    ? sanitized.legalOperations
    : [];
  const openUndos =
    sanitized.openUndos !== null && typeof sanitized.openUndos === "object"
      ? (sanitized.openUndos as Record<string, unknown>)
      : {};
  const legacyRecordIds = new Set(
    ["owned", "origin", "preferredResolution"].flatMap((field) =>
      Array.isArray(openUndos[field])
        ? (openUndos[field] as Array<{ id?: unknown }>)
            .map((record) => record.id)
            .filter((id): id is string => typeof id === "string")
        : []
    )
  );
  delete sanitized.openUndos;
  sanitized.legalOperations = operations.map(sanitizeVersionStructureOperationForAgent);

  if (
    legacyRecordIds.size > 0 &&
    !sanitized.legalOperations.some(
      (operation: Record<string, unknown>) => operation.actionType === "review_context"
    )
  ) {
    sanitized.legalOperations.push({
      actionType: "review_context",
      allowed: true,
      summary:
        "Review legacy audit records before choosing Todo, Deferred, Constraint, or a resolved outcome.",
      blockers: []
    });
  }

  if (legacyRecordIds.size > 0) {
    sanitized.legacyAudit = {
      required: true,
      recordCount: legacyRecordIds.size,
      guidance:
        "Use get_current_context(projectId, includeLegacyUndo=true) for legacy audit details."
    };
  }

  return sanitized;
};

export const sanitizeDocDriftForAgent = (
  result: unknown
): Record<string, unknown> => {
  const sanitized = structuredClone(result) as Record<string, any>;
  const routeTruth =
    sanitized.routeTruth !== null && typeof sanitized.routeTruth === "object"
      ? (sanitized.routeTruth as Record<string, unknown>)
      : {};
  const openUndoCount =
    typeof routeTruth.openUndoCount === "number" ? routeTruth.openUndoCount : 0;
  delete routeTruth.openUndoCount;
  routeTruth.legacyBlockerCount = openUndoCount;
  const hasLegacyRisk =
    openUndoCount > 0 ||
    (Array.isArray(routeTruth.statusRiskCodes) &&
      routeTruth.statusRiskCodes.includes("OPEN_UNDOS_BLOCK_CLOSE"));
  if (Array.isArray(routeTruth.statusRiskCodes)) {
    const statusRiskCodes = routeTruth.statusRiskCodes.map((code) =>
      code === "OPEN_UNDOS_BLOCK_CLOSE" ? "LEGACY_BLOCKERS_REQUIRE_AUDIT" : code
    );
    if (openUndoCount > 0) {
      statusRiskCodes.push("LEGACY_BLOCKERS_REQUIRE_AUDIT");
    }
    routeTruth.statusRiskCodes = [...new Set(statusRiskCodes)];
  }
  sanitized.routeTruth = routeTruth;

  if (Array.isArray(sanitized.warnings)) {
    sanitized.warnings = sanitized.warnings.map((warning: Record<string, unknown>) =>
      warning.code === "OPEN_UNDOS_BLOCK_CLOSE"
        ? {
            ...warning,
            code: "LEGACY_BLOCKERS_REQUIRE_AUDIT",
            summary:
              "Legacy blockers require explicit audit with get_current_context(includeLegacyUndo=true)."
          }
        : warning
    );
  }

  if (hasLegacyRisk && Array.isArray(sanitized.warnings)) {
    const hasLegacyAuditWarning = sanitized.warnings.some(
      (warning: Record<string, unknown>) =>
        warning.code === "LEGACY_BLOCKERS_REQUIRE_AUDIT"
    );

    if (!hasLegacyAuditWarning) {
      sanitized.warnings.push({
        code: "LEGACY_BLOCKERS_REQUIRE_AUDIT",
        severity: "blocking",
        file: null,
        summary:
          "Legacy blockers require explicit audit with get_current_context(includeLegacyUndo=true)."
      });
    }
  }

  if (openUndoCount > 0 || hasLegacyRisk) {
    sanitized.legacyAudit = {
      required: true,
      guidance:
        "Use get_current_context(projectId, includeLegacyUndo=true) for legacy audit details."
    };
  }

  if (typeof sanitized.summaryText === "string") {
    sanitized.summaryText = sanitized.summaryText.replace(
      /Route truth shows (\d+) open todos, \d+ open undos, and (\d+) pending proposals on the current route\./,
      "Route truth shows $1 open todos and $2 pending proposals on the current route."
    );
  }

  return sanitized;
};
