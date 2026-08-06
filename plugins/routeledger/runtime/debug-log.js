import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ROUTELEDGER_DIRECTORY } from "./storage-paths.js";
const DEBUG_LOG_DIRECTORY = path.join(ROUTELEDGER_DIRECTORY, "runtime", "debug", "mcp");
const isTruthy = (value) => value === "1" || value === "true" || value === "yes" || value === "on";
export const isRouteLedgerDebugLogEnabled = () => isTruthy(process.env.ROUTELEDGER_DEBUG_LOG) ||
    isTruthy(process.env.ROUTELEDGER_MCP_DEBUG_LOG);
export class RouteLedgerDebugLogger {
    enabled;
    root;
    instanceToken;
    constructor(options) {
        this.enabled = options.enabled ?? isRouteLedgerDebugLogEnabled();
        this.root = path.join(path.resolve(options.projectRoot), DEBUG_LOG_DIRECTORY);
        this.instanceToken = `${process.pid}-${randomUUID().slice(0, 8)}`;
    }
    async append(input) {
        if (!this.enabled) {
            return null;
        }
        const record = {
            ...input,
            id: randomUUID(),
            ts: new Date().toISOString()
        };
        const filePath = this.getFilePath(record.ts);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
        return record;
    }
    getFilePath(timestamp) {
        const date = new Date(timestamp);
        const validDate = !Number.isNaN(date.getTime());
        const year = validDate ? String(date.getUTCFullYear()) : "unknown-year";
        const month = validDate ? String(date.getUTCMonth() + 1).padStart(2, "0") : "unknown-month";
        const day = validDate ? String(date.getUTCDate()).padStart(2, "0") : "unknown-day";
        const hour = validDate ? String(date.getUTCHours()).padStart(2, "0") : "unknown-hour";
        return path.join(this.root, year, month, day, `${hour}-${this.instanceToken}.jsonl`);
    }
}
