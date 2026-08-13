import { ApplicationError } from "./errors.js";
import { buildVersionCloseoutPlan } from "./version-closeout-planner.js";
import { clampCloseoutEventLimit, collectVersionCloseoutView } from "./version-closeout-query.js";
const collectRequestedVersionCloseoutView = (snapshot, input) => {
    const versionId = input.versionId ?? snapshot.project.currentVersionId;
    if (versionId === null) {
        throw new ApplicationError("VERSION_NOT_FOUND", "project 当前没有 current version", {
            projectId: input.projectId
        });
    }
    return collectVersionCloseoutView({
        snapshot,
        versionId,
        eventLimit: clampCloseoutEventLimit(input.eventLimit)
    });
};
export const summarizeVersionCloseoutApplication = (snapshot, input) => {
    const closeoutView = collectRequestedVersionCloseoutView(snapshot, input);
    return {
        data: closeoutView.summary,
        meta: closeoutView.meta
    };
};
export const planVersionCloseoutApplication = (snapshot, input) => {
    const closeoutView = collectRequestedVersionCloseoutView(snapshot, input);
    return {
        data: buildVersionCloseoutPlan(closeoutView),
        meta: closeoutView.meta
    };
};
