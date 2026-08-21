import type { Actor } from "../domain/actor.js";
import type { Version } from "../domain/version.js";
import type { StoragePort } from "../ports/storage-port.js";
import { createDomainContext, type DomainDependencies } from "../services/operation.js";
import { prepareVersion as prepareVersionDomain } from "../services/version-service.js";

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
}

type VersionCommandStorage = Pick<
  StoragePort,
  "loadProjectAggregate" | "saveProjectAggregate"
>;

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
}
