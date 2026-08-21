import type { Actor } from "../domain/actor.js";
import type { Version } from "../domain/version.js";
import type { ProjectSnapshotReader, ProjectSnapshotWriter } from "../ports/storage-port.js";
import { evaluateCloseGate, resolveResidualAudit } from "../services/gate-service.js";
import { createDomainContext, type DomainDependencies } from "../services/operation.js";
import {
  markVersionComplete as markVersionCompleteDomain,
  prepareVersion as prepareVersionDomain
} from "../services/version-service.js";

import { ApplicationError } from "./errors.js";
import {
  loadRequiredProjectAggregate,
  persistProjectAggregate
} from "./project-aggregate-access.js";

export interface PrepareVersionCommandInput {
  projectId: string;
  versionId: string;
  actor: Actor;
}

export interface VersionCommandUseCases {
  prepareVersion(
    input: PrepareVersionCommandInput
  ): Promise<ReturnType<typeof prepareVersionDomain>>;
  markVersionComplete(input: PrepareVersionCommandInput): Promise<{
    version: Version;
    events: ReturnType<typeof markVersionCompleteDomain>["events"];
    closeReadiness: ReturnType<typeof evaluateCloseGate>;
    warnings: Array<{
      code: "VERSION_COMPLETE_CLOSE_BLOCKED";
      message: string;
      blockerCodes: string[];
      recommendedTool: "check_close_gate";
      toolInput: {
        projectId: string;
        versionId: string;
        residualAudit: { status: "reviewed"; items: never[] };
      };
    }>;
  }>;
}

type VersionCommandStorage = ProjectSnapshotReader & ProjectSnapshotWriter;

const requireVersion = (
  versions: Version[],
  projectId: string,
  versionId: string
): Version => {
  const version = versions.find((item) => item.id === versionId);

  if (version === undefined) {
    throw new ApplicationError("VERSION_NOT_FOUND", "version 不存在", {
      projectId,
      versionId
    });
  }

  if (version.projectId !== projectId) {
    throw new ApplicationError("VERSION_OWNERSHIP_MISMATCH", "version 不属于当前 project", {
      projectId,
      versionId,
      actualProjectId: version.projectId
    });
  }

  return version;
};

export class VersionCommandService implements VersionCommandUseCases {
  private readonly storage: VersionCommandStorage;

  private readonly deps: DomainDependencies;

  constructor(options: { storage: VersionCommandStorage; deps: DomainDependencies }) {
    this.storage = options.storage;
    this.deps = options.deps;
  }

  async prepareVersion(input: PrepareVersionCommandInput) {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    const version = requireVersion(snapshot.versions, input.projectId, input.versionId);
    const prepared = prepareVersionDomain(
      version,
      createDomainContext(this.deps, input.actor),
      this.deps
    );

    snapshot.versions = snapshot.versions.map((item) =>
      item.id === prepared.version.id ? prepared.version : item
    );
    snapshot.events = snapshot.events.concat(prepared.events);
    await persistProjectAggregate(this.storage, snapshot);

    return prepared;
  }

  async markVersionComplete(input: PrepareVersionCommandInput) {
    const snapshot = await loadRequiredProjectAggregate(this.storage, input.projectId);
    const version = requireVersion(snapshot.versions, input.projectId, input.versionId);
    const completed = markVersionCompleteDomain(
      version,
      createDomainContext(this.deps, input.actor),
      this.deps
    );

    snapshot.versions = snapshot.versions.map((item) =>
      item.id === completed.version.id ? completed.version : item
    );
    snapshot.events = snapshot.events.concat(completed.events);
    await persistProjectAggregate(this.storage, snapshot);

    const residualAudit = resolveResidualAudit(
      undefined,
      snapshot.pendingOperations
        .filter(
          (operation) =>
            operation.status === "pending" &&
            operation.actionType === "close_version" &&
            operation.targetId === input.versionId
        )
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((operation) => ({
          id: operation.id,
          residualAudit: operation.payload.residualAudit,
          residualAuditReviewed: operation.payload.residualAuditReviewed
        }))
    );
    const closeReadiness = evaluateCloseGate({
      version: completed.version,
      todos: snapshot.todos.filter((todo) => todo.versionId === input.versionId),
      undos: snapshot.undos.filter(
        (undo) =>
          undo.versionId === input.versionId ||
          undo.originVersionId === input.versionId ||
          undo.preferredResolutionVersionId === input.versionId
      ),
      residualAudit: residualAudit.audit,
      knownVersions: snapshot.versions,
      deferredItems: snapshot.deferredItems,
      constraints: snapshot.constraints,
      constraintChecks: []
    });

    return {
      ...completed,
      closeReadiness,
      warnings: closeReadiness.allowed
        ? []
        : [
            {
              code: "VERSION_COMPLETE_CLOSE_BLOCKED" as const,
              message:
                "Version 已标记 complete，但 close gate 仍有阻断项；请在关闭前完成收口。",
              blockerCodes: closeReadiness.blockers.map((blocker) => blocker.code),
              recommendedTool: "check_close_gate" as const,
              toolInput: {
                projectId: input.projectId,
                versionId: input.versionId,
                residualAudit: { status: "reviewed" as const, items: [] }
              }
            }
          ]
    };
  }
}
