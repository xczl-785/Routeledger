import { createHmac, timingSafeEqual } from "node:crypto";

export interface RouteLedgerMcpRequestState {
  readonly schemaVersion: 1;
  readonly toolName: "execute_l3_operation";
  readonly argumentsDigest: string;
  readonly pendingOperationId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
};

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(canonicalize(value)), "utf8").toString("base64url");

const sign = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(payload).digest("base64url");

export const digestMcpToolArguments = (input: Record<string, unknown>): string =>
  createHmac("sha256", "routeledger-mcp-arguments-v1")
    .update(JSON.stringify(canonicalize(input)))
    .digest("base64url");

export const sealMcpRequestState = (
  state: RouteLedgerMcpRequestState,
  secret: string
): string => {
  if (secret.length < 32) throw new Error("MCP request-state secret must be at least 32 characters.");
  const payload = encode(state);
  return `${payload}.${sign(payload, secret)}`;
};

export const verifyMcpRequestState = (
  token: string,
  secret: string,
  expected: { readonly toolName: string; readonly argumentsDigest: string; readonly now?: Date }
): RouteLedgerMcpRequestState => {
  if (secret.length < 32) throw new Error("MCP request-state secret must be at least 32 characters.");
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) throw new Error("Invalid MCP request state.");
  const expectedSignature = Buffer.from(sign(payload, secret), "utf8");
  const actualSignature = Buffer.from(signature, "utf8");
  if (
    expectedSignature.length !== actualSignature.length ||
    !timingSafeEqual(expectedSignature, actualSignature)
  ) {
    throw new Error("MCP request state integrity check failed.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid MCP request state payload.");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid MCP request state payload.");
  }
  const state = decoded as Partial<RouteLedgerMcpRequestState>;
  if (
    state.schemaVersion !== 1 ||
    state.toolName !== "execute_l3_operation" ||
    state.toolName !== expected.toolName ||
    state.argumentsDigest !== expected.argumentsDigest ||
    typeof state.pendingOperationId !== "string" ||
    state.pendingOperationId.length === 0 ||
    typeof state.issuedAt !== "string" ||
    typeof state.expiresAt !== "string"
  ) {
    throw new Error("MCP request state does not match the retried tool call.");
  }
  const now = expected.now ?? new Date();
  if (!Number.isFinite(Date.parse(state.expiresAt)) || Date.parse(state.expiresAt) <= now.getTime()) {
    throw new Error("MCP request state has expired.");
  }
  return state as RouteLedgerMcpRequestState;
};
