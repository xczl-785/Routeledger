import type { Actor } from "./actor.js";

export type AssetPathBase = "project_root";
export type AssetStatus = "active" | "missing" | "path_unverified";

export interface AssetPathHistoryEntry {
  pathBase: AssetPathBase;
  relativePath: string;
  recordedAt: string;
}

export interface Asset {
  id: string;
  projectId: string;
  workItemIds: string[];
  pathBase: AssetPathBase;
  relativePath: string;
  status: AssetStatus;
  pathHistory: AssetPathHistoryEntry[];
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
}
