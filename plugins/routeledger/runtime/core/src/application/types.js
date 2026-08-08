export const L3_ACTION_TYPES = [
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
];
export const BATCH_CREATE_VERSIONS_MODES = ["preflight", "propose"];
export const isBatchCreateVersionsMode = (value) => typeof value === "string" &&
    BATCH_CREATE_VERSIONS_MODES.includes(value);
export const BATCH_PREVIOUS_CURRENT_POLICIES = [
    "leave_as_is",
    "require_complete_or_close"
];
export const isBatchPreviousCurrentPolicy = (value) => typeof value === "string" &&
    BATCH_PREVIOUS_CURRENT_POLICIES.includes(value);
export const ROUTE_OPERATION_WORKFLOW_MODES = ["dry_run", "propose"];
export const isRouteOperationWorkflowMode = (value) => typeof value === "string" &&
    ROUTE_OPERATION_WORKFLOW_MODES.includes(value);
