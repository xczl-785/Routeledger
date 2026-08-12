import { randomUUID } from "node:crypto";
import { assertDecisionResolutionMatchesRequest, validateL3AuthorizationGrant } from "../../core/src/index.js";
/**
 * Converts admission of a high-risk RouteLedger tool call by Codex into one
 * exact, single-use capability. Codex owns whether the call is prompted,
 * reviewed, or automatically admitted; RouteLedger owns proposal binding,
 * receipt creation, live validation, and atomic commit after admission.
 */
export class CodexL3DecisionAdapter {
    options;
    id = "codex-native-tool-admission";
    nextId;
    now;
    constructor(options) {
        this.options = options;
        this.nextId = options.nextId ?? randomUUID;
        this.now = options.now ?? (() => new Date());
    }
    async resolve(request) {
        const now = this.now();
        const grant = {
            id: this.nextId(),
            issuer: "codex-native-tool-admission",
            subjectId: this.options.authorizationContext.subjectId,
            audience: this.options.authorizationContext.audience,
            projectId: request.projectId,
            routeledgerRootDigest: this.options.authorizationContext.routeledgerRootDigest,
            allowedActions: [request.actionType],
            allowedTargetIds: [request.targetId],
            operationDigest: request.operationDigest,
            scope: "operation",
            source: "host_admission",
            policyId: null,
            policyDigest: null,
            decisionId: `codex-tool-call-${this.nextId()}`,
            hostKind: "codex",
            clientId: this.options.authorizationContext.clientId ?? null,
            sessionId: this.options.sessionId,
            nonce: this.nextId(),
            createdAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
            maxUses: 1,
            uses: 0,
            status: "active",
            revokedAt: null
        };
        const failure = validateL3AuthorizationGrant(grant, this.options.authorizationContext);
        if (failure !== null) {
            throw new Error(`Codex host-admission grant is invalid: ${failure}`);
        }
        await this.options.grantStore.issue(grant);
        const resolution = {
            status: "resolved",
            decision: {
                proposalId: request.proposalId,
                projectId: request.projectId,
                actionType: request.actionType,
                targetId: request.targetId,
                operationDigest: request.operationDigest,
                source: grant.source,
                decisionRef: grant.decisionId,
                authorizationGrantId: grant.id
            }
        };
        assertDecisionResolutionMatchesRequest(request, resolution);
        return resolution;
    }
}
