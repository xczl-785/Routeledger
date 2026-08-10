import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ROUTELEDGER_DIRECTORY } from "./storage-paths.js";

interface UsageEntry {
  policyDigest: string;
  ruleId: string;
  uses: number;
  maxUses: number;
  expiresAt: string;
}

interface UsageDocument {
  version: 1;
  entries: UsageEntry[];
}

export type L3AuthorizationPolicyUsageResult =
  | { ok: true; use: number }
  | { ok: false; code: "POLICY_USE_BUDGET_EXHAUSTED" };

const wait = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

export class FileL3AuthorizationPolicyUsageStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(routeledgerRoot: string) {
    this.filePath = path.join(
      routeledgerRoot,
      ROUTELEDGER_DIRECTORY,
      "l3-authorization-usage.json"
    );
    this.lockPath = `${this.filePath}.lock`;
  }

  consume(input: {
    policyDigest: string;
    ruleId: string;
    maxUses: number;
    expiresAt: string;
    now: string;
  }): L3AuthorizationPolicyUsageResult {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let lock: number | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        lock = fs.openSync(this.lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(this.lockPath).mtimeMs > 30_000) {
            fs.rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        wait(10);
      }
    }
    if (lock === null) throw new Error("Timed out acquiring the L3 policy usage lock");

    try {
      const document = this.readDocument();
      const activeEntries = document.entries.filter(
        (entry) => Date.parse(input.now) < Date.parse(entry.expiresAt)
      );
      const existing = activeEntries.find(
        (entry) =>
          entry.policyDigest === input.policyDigest && entry.ruleId === input.ruleId
      );
      const uses = existing?.uses ?? 0;
      if (uses >= input.maxUses) return { ok: false, code: "POLICY_USE_BUDGET_EXHAUSTED" };

      const updated: UsageEntry = {
        policyDigest: input.policyDigest,
        ruleId: input.ruleId,
        uses: uses + 1,
        maxUses: input.maxUses,
        expiresAt: input.expiresAt
      };
      const nextEntries = activeEntries.filter(
        (entry) =>
          entry.policyDigest !== input.policyDigest || entry.ruleId !== input.ruleId
      );
      nextEntries.push(updated);
      this.writeDocument({ version: 1, entries: nextEntries });
      return { ok: true, use: updated.uses };
    } finally {
      fs.closeSync(lock);
      fs.rmSync(this.lockPath, { force: true });
    }
  }

  private readDocument(): UsageDocument {
    if (!fs.existsSync(this.filePath)) return { version: 1, entries: [] };
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as UsageDocument;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error("Invalid L3 policy usage document");
    }
    return parsed;
  }

  private writeDocument(document: UsageDocument): void {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}
