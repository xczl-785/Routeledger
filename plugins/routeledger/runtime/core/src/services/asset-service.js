import { DomainError } from "../domain/errors.js";
import { createDomainContext } from "./operation.js";
import { createTransitionEvents } from "./transition-event-service.js";
const hasInvalidSegments = (relativePath) => relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
export const validateAssetPath = (pathBase, relativePath) => {
    if (pathBase !== "project_root") {
        throw new DomainError("INVALID_ASSET_PATH", "asset path_base 只允许 project_root", {
            pathBase
        });
    }
    if (relativePath.startsWith("/") ||
        relativePath.includes("\\") ||
        /^[A-Za-z]:/.test(relativePath) ||
        hasInvalidSegments(relativePath)) {
        throw new DomainError("INVALID_ASSET_PATH", "asset relative_path 非法", {
            relativePath
        });
    }
};
export const createAsset = ({ projectId, workItemIds, pathBase, relativePath, status = "active", actor, deps }) => {
    validateAssetPath(pathBase, relativePath);
    const context = createDomainContext(deps, actor);
    const historyEntry = {
        pathBase,
        relativePath,
        recordedAt: context.now
    };
    const asset = {
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
        events: createTransitionEvents([
            {
                targetType: "asset",
                targetId: asset.id,
                eventType: "asset.created",
                note: relativePath
            }
        ], {
            projectId,
            operationId: context.operationId,
            actor,
            now: context.now
        }, deps.idGenerator)
    };
};
