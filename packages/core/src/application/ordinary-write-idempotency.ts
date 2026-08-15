import type { Actor } from "../domain/actor.js";

export const ORDINARY_WRITE_COMMAND_NAMES = [
  "create_todo",
  "close_todo",
  "defer_work",
  "review_deferred",
  "record_constraint",
  "retire_constraint"
] as const;

export type OrdinaryWriteCommandName =
  (typeof ORDINARY_WRITE_COMMAND_NAMES)[number];

export interface OrdinaryWriteReceipt {
  id: string;
  projectId: string;
  commandName: OrdinaryWriteCommandName;
  idempotencyKey: string;
  inputDigest: string;
  resultSchemaVersion: 1;
  result: Record<string, unknown>;
  actor: Actor;
  committedAt: string;
}

export interface IdempotencyResultMetadata {
  protected: true;
  receiptId: string;
  replayed: boolean;
}
