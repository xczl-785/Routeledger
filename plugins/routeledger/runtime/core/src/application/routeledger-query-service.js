import { buildCurrentContextResult, buildNextActionResult, buildVersionsWindowResult } from "./current-context-query.js";
import { loadRequiredProjectAggregate } from "./project-aggregate-access.js";
import { planVersionCloseoutApplication, summarizeVersionCloseoutApplication } from "./version-closeout-application.js";
export class RouteLedgerQueryService {
    storage;
    constructor(options) {
        this.storage = options.storage;
    }
    async listVersions(projectId) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, projectId);
        return snapshot.versions.slice().sort((left, right) => left.order - right.order);
    }
    async listVersionsWindow(input) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        return buildVersionsWindowResult(snapshot, input);
    }
    async getCurrentContext(input) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        return buildCurrentContextResult(snapshot, input);
    }
    async getNextAction(input) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        return buildNextActionResult(snapshot, input);
    }
    async summarizeVersionCloseout(input) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        return summarizeVersionCloseoutApplication(snapshot, input);
    }
    async planVersionCloseout(input) {
        const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
        return planVersionCloseoutApplication(snapshot, input);
    }
}
