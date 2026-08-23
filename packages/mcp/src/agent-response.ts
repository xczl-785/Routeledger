const AGENT_CODE_MESSAGES: Record<string, string> = {
  CONTENT_LOCALE_REQUIRED:
    "The project content_locale is unresolved; confirm a concrete locale with the user first.",
  CONTENT_LOCALE_MUST_BE_CONCRETE: "content_locale must be concrete and cannot be auto.",
  CONTENT_LOCALE_INVALID: "content_locale must be a valid BCP 47 locale.",
  ROUTE_EMPTY: "The Project route is empty; create the first real Version first.",
  CURRENT_VERSION_MISMATCH: "fromVersionId does not match the current Version.",
  CURRENT_VERSION_NOT_CLOSED: "The current Version must be closed before advancing.",
  TARGET_VERSION_NOT_NEXT: "The target Version is not the current Version's direct successor.",
  START_GATE_FAILED: "The Version start gate did not pass.",
  START_GATE_BLOCKED: "The Version start gate did not pass.",
  CLOSE_GATE_FAILED: "The Version close gate did not pass.",
  INVALID_TOOL_INPUT: "The tool input is invalid.",
  INVALID_VERSION_TRANSITION: "The current Version state does not allow this operation.",
  INVALID_TODO_TRANSITION: "The current Todo state does not allow this operation.",
  TARGET_ALREADY_CURRENT: "The target Version is already current.",
  VERSION_ALREADY_CLOSED: "The target Version is already closed.",
  TARGET_VERSION_NOT_COMPLETE: "Only a Version in the `complete` state can be closed.",
  TARGET_VERSION_NOT_READY: "Only a Version in the `ready` state can be started.",
  MISSING_RESIDUAL_AUDIT: "A residual audit is required before the Version can be closed.",
  OPEN_TODOS: "Open Todos remain.",
  OPEN_UNDOS: "Legacy work remains and requires explicit audit before the Version can be closed.",
  OPEN_DUE_UNDOS: "Due legacy work requires explicit audit before the target Version can start.",
  SELF_REFERENTIAL_UNDO_BLOCKS_START:
    "Self-referential legacy work blocks the target Version from starting.",
  LEGACY_WORK_REQUIRES_AUDIT:
    "Legacy work blocks this operation and requires an explicit legacy audit.",
  LEGACY_BLOCKERS_REQUIRE_AUDIT:
    "Legacy blockers require an explicit legacy audit.",
  OPEN_TODOS_BLOCK_CLOSE: "Open Todos block the current Version from closing.",
  UNRESOLVED_DEFERRED_BLOCKS_CLOSE:
    "Improperly routed Deferred work blocks the current Version from closing.",
  DEFERRED_ROUTE_TARGET_REQUIRED: "The Deferred route requires a target Version.",
  DEFERRED_ROUTE_TARGET_SELF: "Deferred work cannot be routed back to its source Version.",
  DEFERRED_ROUTE_CONTEXT_REQUIRED:
    "Validating the Deferred route requires the complete known-Version context.",
  DEFERRED_ROUTE_TARGET_UNKNOWN: "The Deferred route target Version does not exist.",
  DEFERRED_ROUTE_TARGET_CROSS_PROJECT:
    "The Deferred route target Version belongs to a different Project.",
  DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM:
    "The Deferred route target must be downstream from its source Version.",
  DUE_DEFERRED_REQUIRES_REVIEW:
    "Due Deferred work must be reviewed before the target Version can start.",
  MISSING_DECISION_REFS: "Required route-decision references are missing.",
  INVALID_RESIDUAL_AUDIT_DESTINATION:
    "Every residual-audit item requires a structured destination.",
  RESIDUAL_DESTINATION_RECORD_REQUIRED:
    "A non-close residual destination must reference an existing handoff record.",
  RESIDUAL_DESTINATION_RECORD_NOT_FOUND:
    "The residual destination record does not exist.",
  RESIDUAL_DESTINATION_RECORD_NOT_ACTIONABLE:
    "The residual destination record is no longer actionable.",
  RESIDUAL_DESTINATION_RECORD_MISMATCH:
    "The residual destination record does not match the declared handoff.",
  UNKNOWN_CONSTRAINT_GATE_CHECK:
    "The gate references a Constraint that does not exist.",
  MISMATCHED_CONSTRAINT_GATE_CHECK:
    "The Constraint gate check does not match the target Project or Version scope.",
  CONSTRAINT_VIOLATED: "A Constraint is explicitly violated.",
  CONSTRAINT_EVIDENCE_MISSING: "Evidence required by a Constraint is missing.",
  PENDING_L3_PROPOSAL_NEEDS_DECISION:
    "An L3 proposal is pending approval or rejection.",
  CURRENT_VERSION_CLOSED_NEXT_VERSION_WAITING:
    "The current boundary is closed and the next Version is still in `wait`.",
  CURRENT_VERSION_COMPLETE_NOT_CLOSED: "The current Version is complete but not closed.",
  CURRENT_VERSION_SHUTDOWN:
    "The current Version was closed through shutdown and requires manual review.",
  CURRENT_POINTER_DRIFT_RUNNING_VERSION:
    "The current pointer does not match the only running Version.",
  DIAGNOSTIC_VERSION_NOISE:
    "Diagnostic or probe Versions may be interfering with route decisions.",
  CONFIRMATION_REQUIRED: "The operation requires explicit confirmation.",
  COMMIT_REPLAY_MISMATCH:
    "A committed operation can only be replayed with its original, exactly matching approval artifact.",
  PENDING_OPERATION_PERSISTENCE_MISMATCH:
    "The persisted pending operation did not match its digest, so commit was blocked.",
  PROJECT_NOT_FOUND: "The specified Project was not found.",
  VERSION_NOT_FOUND: "The specified Version was not found.",
  TODO_NOT_FOUND: "The specified Todo was not found.",
  DEFERRED_NOT_FOUND: "The specified Deferred item was not found.",
  CONSTRAINT_NOT_FOUND: "The specified Constraint was not found.",
  WRITE_IN_PROGRESS: "A canonical JSON write is already active for this RouteLedger root."
};

const AGENT_ACTION_DESCRIPTIONS: Record<string, string> = {
  confirm_content_locale:
    "Confirm a concrete content_locale with the user before initialization or further writes.",
  set_project_content_locale:
    "Set the existing project to the concrete content_locale confirmed by the user.",
  continue_route:
    "The Todo is closed; do not retry the write and continue with the next route action.",
  choose_legal_deferred_target:
    "Choose a legal downstream Version from eligibleTargetVersions and retry the Deferred operation.",
  propose_downstream_version:
    "Propose a downstream Version, complete its approval flow, then retry the Deferred operation.",
  inspect_version_structure:
    "Inspect the current Version structure and legal operations before retrying.",
  retry_create_version:
    "Retry propose_version_creation against the current route; do not reuse a stale tail ID as the new target.",
  reject_stale_proposal: "Reject the stale proposal before creating a replacement.",
  refresh_context: "Refresh the current route and work context.",
  resolve_live_blocker: "Resolve the live blocker recorded in the gate difference.",
  recheck_close_gate: "Recheck the close gate against live state.",
  propose_replacement: "Create a replacement proposal only after the live gate passes."
};

const MISSION_CONTROL_NOTICE_MESSAGES: Record<string, (accessUrl: string | null) => string> = {
  MISSION_CONTROL_RUNNING: (accessUrl) =>
    `RouteLedger Mission Control is running. Open it at: ${accessUrl ?? "the reported local address"}`,
  MISSION_CONTROL_STOPPED: () =>
    "RouteLedger Mission Control is not running. Would you like to start it and open the current project?",
  MISSION_CONTROL_PROJECT_UNREGISTERED: () =>
    "RouteLedger Mission Control is running, but the current project is not registered. Would you like to add and open it?",
  MISSION_CONTROL_INCOMPATIBLE: () =>
    "An incompatible RouteLedger Mission Control is running. Would you like to replace it with the current runtime and open the current project?",
  MISSION_CONTROL_STATUS_ERROR: () =>
    "RouteLedger could not inspect Mission Control status. Route work can continue."
};

const AGENT_NEXT_ACTIONS: Record<string, { summary: string; reason: string }> = {
  advance_to_version: {
    summary: "Atomically switch to and start the next Version.",
    reason: "The current boundary is closed and the ready target passes its start gate."
  },
  create_version: {
    summary: "Create the first real Version after confirming it with the user.",
    reason: "The Project root exists, but the route is still empty."
  },
  close_todo: {
    summary: "Close the current Version's unfinished Todo first.",
    reason: "An open Todo blocks Version closeout."
  },
  close_version: {
    summary: "Prepare the residual audit, then close the current Version.",
    reason: "The current Version is complete but not closed."
  },
  decision_required: {
    summary: "Decide whether the running Version needs more recorded work.",
    reason: "The current Version is running but has no open Todo."
  },
  prepare_version: {
    summary: "Prepare the target Version.",
    reason: "The target Version is still in `wait`."
  },
  review_context: {
    summary: "Review the current RouteLedger context first.",
    reason: "The current gate or route state requires further handling."
  },
  review_deferred: {
    summary: "Review the blocking Deferred work first.",
    reason: "The Deferred state prevents the current route operation."
  },
  review_pending_proposal: {
    summary: "Resolve the pending L3 proposal first.",
    reason: "The pending proposal affects subsequent route decisions."
  },
  review_residual_audit: {
    summary: "Review and declare the residual audit first.",
    reason: "The ordinary close gate has no reviewed residual-audit declaration."
  },
  set_current_version: {
    summary: "Repair the current Version pointer.",
    reason: "The current pointer does not match the running boundary."
  },
  start_version: {
    summary: "Propose starting the target Version.",
    reason:
      "The target Version is ready and its start gate passes; starting still requires L3 approval and exact execution."
  },
  work_todo: {
    summary: "Continue the current Version's open Todo.",
    reason:
      "The target is the deterministically ordered current work item; this order is not a business priority."
  },
  none: {
    summary: "There is no single clear next action.",
    reason: "Review the complete context before deciding what to do next."
  }
};

const AGENT_CHOICE_WHEN: Record<string, string> = {
  create_todo: "Implementation work remains.",
  mark_version_complete: "Implementation is actually complete."
};

const AGENT_TRANSITION_LABELS: Record<string, string> = {
  "Review pending L3 proposals": "Review pending L3 proposals",
  "Prepare current version": "Prepare current Version",
  "Start current version": "Start current Version",
  "Approve start proposal": "Approve start proposal",
  "Commit start proposal": "Commit start proposal",
  "Close current version boundary": "Close the current Version boundary",
  "Approve close proposal": "Approve close proposal",
  "Commit close proposal": "Commit close proposal",
  "Close from version boundary": "Close the source Version boundary",
  "Prepare target version": "Prepare the target Version",
  "Start target version": "Start the target Version",
  "Advance to target version": "Advance to the target Version",
  "Set current to target version": "Set the target Version as current",
  "Approve transition proposal": "Approve transition proposal",
  "Commit transition proposal": "Commit transition proposal",
  "Start target after current switch": "Start the target Version after switching current"
};

const AGENT_TRANSITION_REASONS: Record<string, string> = {
  "review-pending-proposals":
    "Existing pending proposals can change the live route; resolve them before continuing.",
  "prepare-current-version":
    "The current Version is still in `wait`; prepare it before reading the guide again.",
  "start-current-version":
    "Create a start_version proposal only after the current Version is ready and its start gate passes.",
  "approve-start-current-proposal": "Approve the start_version proposal before commit.",
  "commit-start-current-proposal": "Commit the start_version proposal after approval.",
  "close-current-version":
    "Create a close proposal only after the current Version close gate passes.",
  "approve-close-current-proposal": "Approve the close proposal before commit.",
  "commit-close-current-proposal": "Commit the close proposal with its approval artifact.",
  "close-from-version": "Close the source Version boundary before advancing to the target.",
  "approve-close-proposal": "Approve the source close proposal before commit.",
  "commit-close-proposal": "Commit the source close proposal with its approval artifact.",
  "prepare-target-version": "Prepare the target Version when it is still in `wait`.",
  "transition-to-target":
    "Propose the next legal transition only after the live route and target start gate allow it.",
  "approve-transition-proposal": "Approve the transition proposal before commit.",
  "commit-transition-proposal": "Commit the transition proposal after approval.",
  "start-target-after-switch":
    "After switching current, create a start_version proposal when the target is ready.",
  "approve-start-after-switch": "Approve the target start proposal before commit.",
  "commit-start-after-switch": "Commit the target start proposal after approval."
};

const SYSTEM_CODE_COLLECTION_KEYS = new Set(["blockers", "diagnostics", "issues", "risks", "warnings"]);

const CODED_PRESENTATION_PATHS: Record<string, Set<string>> = {
  propose_version_advance: new Set(["data.blockers"]),
  preflight_or_propose_version_batch: new Set(["data.blockers", "data.issues", "data.risks"]),
  preview_or_propose_version_close: new Set(["data.blockers"]),
  preview_or_propose_forced_version_shutdown: new Set(["data.blockers", "data.ordinaryCloseGate.blockers"]),
  preview_or_propose_version_transition: new Set(["data.blockers"]),
  advance_to_version: new Set(["data.blockers"]),
  batch_create_versions: new Set(["data.blockers", "data.issues", "data.risks"]),
  check_close_gate: new Set(["data.blockers"]),
  check_start_gate: new Set(["data.blockers"]),
  close_version: new Set(["data.blockers"]),
  discover_routeledger_roots: new Set(["data.diagnostics"]),
  get_current_context: new Set(["data.warnings"]),
  get_runtime_context: new Set(["data.diagnostics"]),
  get_version_structure: new Set(["data.legalOperations.blockers"]),
  get_version_transition_guide: new Set(["data.closeGate.blockers", "data.startGate.blockers"]),
  plan_routeledger_binding: new Set(["data.diagnostics", "data.risks"]),
  plan_version_closeout: new Set(["data.blockers"]),
  shutdown_version: new Set(["data.blockers", "data.ordinaryCloseGate.blockers"]),
  summarize_version_closeout: new Set(["data.blockers"]),
  transition_version: new Set(["data.blockers"])
};

const canonicalCodeMessage = (code: string): string =>
  AGENT_CODE_MESSAGES[code] ?? `RouteLedger reported ${code}; inspect the structured details.`;

const isCodedPresentationPath = (toolName: string, path: string[]): boolean =>
  SYSTEM_CODE_COLLECTION_KEYS.has(path.at(-1) ?? "") ||
  (path[0] !== "error" && (CODED_PRESENTATION_PATHS[toolName]?.has(path.join(".")) ?? false));

const normalizeDocDriftPresentation = (record: Record<string, unknown>): void => {
  const project = record.project as Record<string, unknown> | undefined;
  const routeTruth = record.routeTruth as Record<string, unknown> | undefined;
  const currentVersion = routeTruth?.currentVersion as Record<string, unknown> | null | undefined;
  const checkedFiles = Array.isArray(record.checkedFiles) ? record.checkedFiles : [];
  const unreadableFiles = Array.isArray(record.unreadableFiles) ? record.unreadableFiles : [];
  const warnings = Array.isArray(record.warnings)
    ? (record.warnings as Array<Record<string, unknown>>)
    : [];
  const coverage = record.coverage as Record<string, unknown> | undefined;
  const currentVersionText =
    currentVersion === null || currentVersion === undefined
      ? "There is no current Version."
      : `Current Version: ${String(currentVersion.title)} (${String(currentVersion.id)}).`;

  if (typeof record.summaryText === "string") {
    record.summaryText = [
      `Checked ${checkedFiles.length} entry files for project ${String(project?.name ?? "")}.`,
      currentVersionText,
      `The current route has ${Number(routeTruth?.openTodoCount ?? 0)} open Todos, ${Number(routeTruth?.openUndoCount ?? 0)} open Undos, and ${Number(routeTruth?.pendingProposalCount ?? 0)} pending proposals.`,
      `Alignment status: ${String(record.alignmentStatus ?? "unknown")}; safe to trust: ${record.safeToTrust === true ? "yes" : "no"}.`,
      `Found ${warnings.length} warnings and ${unreadableFiles.length} unreadable files.`,
      `Coverage is ${String(coverage?.level ?? "partial")}: ${Number(coverage?.recognizedAssertionCount ?? 0)} explicit current-Version declarations were recognized and ${Number(coverage?.notDetectedAssertionCount ?? 0)} declaration fields were not detected.`
    ].join(" ");
  }

  for (const warning of warnings) {
    const file = typeof warning.file === "string" ? warning.file : null;
    if (warning.code === "STALE_CURRENT_VERSION") {
      if (typeof warning.assertionKind === "string") {
        warning.summary = `${file ?? "An entry document"} declares ${warning.assertionKind} inconsistently with the current RouteLedger truth.`;
      } else {
        warning.summary = `${file ?? "An entry document"} mentions the current route without an explicit comparable current-Version ID, title, or state declaration.`;
        warning.actual =
          "The document mentions the current route without an explicit comparable current-Version declaration.";
      }
    } else if (warning.code === "STALE_TRUTH_SOURCE") {
      warning.summary = `${file ?? "An entry document"} presents SQLite as the source of truth without identifying .routeledger canonical JSON as the current source.`;
      warning.expected = ".routeledger canonical JSON is the runtime source of truth.";
      warning.actual = "SQLite is presented as the source of truth.";
    } else if (warning.code === "MISSING_EXPECTED_POINTER") {
      warning.summary = `No entry document points to the expected path ${String(warning.expected ?? "")}.`;
      warning.actual = "No checked entry file contains the expected pointer path.";
    } else if (warning.code === "UNREADABLE_ENTRY_FILE") {
      warning.summary = `${file ?? "An entry document"} could not be read, so its drift check was not completed.`;
    }
  }

  if (coverage !== undefined && Array.isArray(coverage.limitations)) {
    coverage.limitations = [
      "Explicit Chinese or English current-Version declarations are compared; short current-state aliases require nearby current-Version context.",
      "A partial result does not prove that every route statement in the checked documents is current."
    ];
  }
};

const normalizeVersionStructureOperation = (record: Record<string, unknown>): void => {
  if (typeof record.actionType !== "string" || typeof record.summary !== "string") return;
  const summaries: Record<string, string> = {
    prepare_version: "wait -> ready",
    mark_version_complete: "running -> complete",
    close_version: "complete -> close; requires residual audit and closure of every open item.",
    shutdown_version:
      "Forced path: emergency shutdown closes the Version even when ordinary close blockers remain.",
    reopen_version: "close|suspend -> ready",
    set_current_version:
      "Switch the current pointer; a running previous current Version is suspended automatically.",
    create_todo: "Add a Todo to the current Version."
  };
  if (summaries[record.actionType] !== undefined) {
    record.summary = summaries[record.actionType];
    return;
  }
  if (record.actionType !== "transition_version") return;
  const stepsRemaining =
    record.details !== null && typeof record.details === "object"
      ? (record.details as Record<string, unknown>).stepsRemaining
      : undefined;
  record.summary =
    Array.isArray(stepsRemaining) && stepsRemaining.length > 0
      ? `Remaining steps: ${stepsRemaining.join(" -> ")}`
      : record.summary.includes("already current")
        ? "The target Version is already current and running."
        : "Transition is not currently available.";
};

const normalizeSystemValue = (value: unknown, path: string[], toolName: string): unknown => {
  if (path.includes("metadata") || path.includes("payload")) return value;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSystemValue(item, path, toolName));
  }
  if (value === null || typeof value !== "object") return value;

  const record = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      normalizeSystemValue(child, [...path, key], toolName)
    ])
  );

  if (
    toolName === "get_runtime_context" &&
    path.at(-1) === "notice" &&
    typeof record.code === "string" &&
    typeof record.message === "string"
  ) {
    const render = MISSION_CONTROL_NOTICE_MESSAGES[record.code];
    if (render !== undefined) {
      record.message = render(typeof record.accessUrl === "string" ? record.accessUrl : null);
    }
  }
  if (
    isCodedPresentationPath(toolName, path) &&
    typeof record.code === "string" &&
    typeof record.message === "string"
  ) {
    record.message = canonicalCodeMessage(record.code);
  }
  if (
    record.code === "INVALID_TODO_TRANSITION" &&
    record.details !== null &&
    typeof record.details === "object" &&
    !Array.isArray(record.details) &&
    ((record.details as Record<string, unknown>).status === "closed" ||
      (record.details as Record<string, unknown>).recoveryState === "already_applied") &&
    typeof record.message === "string"
  ) {
    record.message = "The Todo is already closed; do not retry it and continue with the route.";
  }
  if (
    isCodedPresentationPath(toolName, path) &&
    typeof record.code === "string" &&
    typeof record.summary === "string"
  ) {
    record.summary = canonicalCodeMessage(record.code);
  }
  if (
    path.at(-1) === "recommendedNextActions" &&
    typeof record.type === "string" &&
    typeof record.description === "string" &&
    AGENT_ACTION_DESCRIPTIONS[record.type] !== undefined
  ) {
    record.description = AGENT_ACTION_DESCRIPTIONS[record.type];
  }
  if (typeof record.actionType === "string" && path.at(-1) === "nextAction") {
    const action = AGENT_NEXT_ACTIONS[record.actionType];
    if (action !== undefined) {
      if (record.actionType === "create_version" && typeof record.targetId === "string") {
        record.summary = "Append one successor Version after the closed top-level tail.";
        record.reason =
          "The route ends at an ordinarily closed top-level Version and can continue with a real successor.";
      } else {
        record.summary = action.summary;
        record.reason = action.reason;
      }
    }
  }
  if (
    typeof record.actionType === "string" &&
    path.at(-1) === "choices" &&
    typeof record.when === "string" &&
    AGENT_CHOICE_WHEN[record.actionType] !== undefined
  ) {
    record.when = AGENT_CHOICE_WHEN[record.actionType];
  }
  if (toolName === "get_version_structure" && path.at(-1) === "legalOperations") {
    normalizeVersionStructureOperation(record);
  }
  if (toolName === "get_version_transition_guide" && path.at(-1) === "recommendedSteps") {
    if (typeof record.label === "string" && AGENT_TRANSITION_LABELS[record.label] !== undefined) {
      record.label = AGENT_TRANSITION_LABELS[record.label];
    }
    if (
      typeof record.stepId === "string" &&
      typeof record.reason === "string" &&
      AGENT_TRANSITION_REASONS[record.stepId] !== undefined
    ) {
      record.reason = AGENT_TRANSITION_REASONS[record.stepId];
    }
  }
  if (toolName === "check_doc_drift" && path.length === 1) {
    normalizeDocDriftPresentation(record);
  }
  return record;
};

export const normalizeAgentToolResponse = <T extends {
  data?: unknown;
  error?: unknown;
  meta?: Record<string, unknown>;
}>(response: T, toolName: string): T => ({
  ...response,
  ...(response.data === undefined
    ? {}
    : { data: normalizeSystemValue(response.data, ["data"], toolName) }),
  ...(response.error === undefined
    ? {}
    : {
        error: (() => {
          const normalized = normalizeSystemValue(response.error, ["error"], toolName) as Record<string, unknown>;
          if (typeof normalized.code === "string" && typeof normalized.message === "string") {
            const details =
              normalized.details !== null &&
              typeof normalized.details === "object" &&
              !Array.isArray(normalized.details)
                ? (normalized.details as Record<string, unknown>)
                : null;
            normalized.message =
              normalized.code === "INVALID_TODO_TRANSITION" &&
              (details?.status === "closed" || details?.recoveryState === "already_applied")
                ? "The Todo is already closed; do not retry it and continue with the route."
                : canonicalCodeMessage(normalized.code);
          }
          return normalized;
        })()
      }),
  meta: { ...(response.meta ?? {}) }
});
