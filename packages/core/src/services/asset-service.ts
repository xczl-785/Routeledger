import { DomainError } from "../domain/errors.js";
import type { Asset, AssetPathBase, AssetPathHistoryEntry, AssetStatus } from "../domain/asset.js";
import type { TransitionEvent } from "../domain/transition-event.js";
import type { Actor } from "../domain/actor.js";
import type { DomainDependencies } from "./operation.js";
import { createDomainContext } from "./operation.js";
import { createTransitionEvents } from "./transition-event-service.js";

export interface CreateAssetInput {
  projectId: string;
  workItemIds: string[];
  pathBase: AssetPathBase;
  relativePath: string;
  status?: AssetStatus;
  actor: Actor;
  deps: DomainDependencies;
}

export interface AssetCreation {
  asset: Asset;
  events: TransitionEvent[];
}

const hasInvalidSegments = (relativePath: string): boolean =>
  relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..");

export const validateAssetPath = (
  pathBase: AssetPathBase,
  relativePath: string
): void => {
  if (pathBase !== "project_root") {
    throw new DomainError("INVALID_ASSET_PATH", "asset path_base 只允许 project_root", {
      pathBase
    });
  }

  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    /^[A-Za-z]:/.test(relativePath) ||
    hasInvalidSegments(relativePath)
  ) {
    throw new DomainError("INVALID_ASSET_PATH", "asset relative_path 非法", {
      relativePath
    });
  }
};

export const createAsset = ({
  projectId,
  workItemIds,
  pathBase,
  relativePath,
  status = "active",
  actor,
  deps
}: CreateAssetInput): AssetCreation => {
  validateAssetPath(pathBase, relativePath);
  const context = createDomainContext(deps, actor);
  const historyEntry: AssetPathHistoryEntry = {
    pathBase,
    relativePath,
    recordedAt: context.now
  };

  const asset: Asset = {
    id: deps.idGenerator.nextId(),
    projectId,
    workItemIds,
    pathBase,
    relativePath,
    status,
    pathHistory: [historyEntry],
    createdBy: actor,
    createdAt: context.now,
    updatedAt: context.now
  };

  return {
    asset,
    events: createTransitionEvents(
      [
        {
          targetType: "asset",
          targetId: asset.id,
          eventType: "asset.created",
          note: relativePath
        }
      ],
      {
        projectId,
        operationId: context.operationId,
        actor,
        now: context.now
      },
      deps.idGenerator
    )
  };
};
