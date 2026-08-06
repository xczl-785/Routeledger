export const DOMAIN_ERROR_CODES = [
  "INVALID_VERSION_TRANSITION",
  "START_GATE_FAILED",
  "CLOSE_GATE_FAILED",
  "INVALID_TODO_TRANSITION",
  "INVALID_UNDO_TRANSITION",
  "INVALID_DEFERRED_TRANSITION",
  "INVALID_CONSTRAINT_TRANSITION",
  "DEFERRED_ROUTE_CONTEXT_REQUIRED",
  "DEFERRED_ROUTE_TARGET_REQUIRED",
  "DEFERRED_ROUTE_TARGET_SELF",
  "DEFERRED_ROUTE_TARGET_UNKNOWN",
  "DEFERRED_ROUTE_TARGET_CROSS_PROJECT",
  "DEFERRED_ROUTE_TARGET_NOT_DOWNSTREAM",
  "INVALID_WORK_ITEM_ACTIVE",
  "INVALID_ASSET_PATH",
  "INVALID_OPERATION_ID",
  "MISSING_REQUIRED_FIELD",
  "PROJECT_VERSION_MISMATCH"
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
