import { describe, expect, it } from "vitest";

import {
  getProjectAggregateHeadRevision,
  type ProjectAggregateSnapshot,
  type ProjectSnapshotWriter
} from "../index.js";
import { persistProjectAggregate } from "../application/project-aggregate-access.js";
import { createProjectFixture } from "./builders.js";

const createSnapshot = (): ProjectAggregateSnapshot => ({
  headRevision: null,
  project: createProjectFixture(),
  versions: [],
  workItems: [],
  todos: [],
  undos: [],
  deferredItems: [],
  constraints: [],
  assets: [],
  events: [],
  pendingOperations: [],
  approvalArtifacts: []
});

describe("storage revision port", () => {
  it("keeps the revision as explicit cloneable runtime metadata", () => {
    const snapshot = createSnapshot();
    snapshot.headRevision = "revision-1";

    const cloned = structuredClone(snapshot);

    expect(cloned.headRevision).toBe("revision-1");
    expect(Object.getOwnPropertySymbols(snapshot)).toEqual([]);
    expect(getProjectAggregateHeadRevision(snapshot)).toBe("revision-1");
  });

  it("updates the caller snapshot from the writer's returned revision", async () => {
    const snapshot = createSnapshot();
    const writer: ProjectSnapshotWriter = {
      saveProjectAggregate: async (candidate) => {
        expect(candidate.headRevision).toBeNull();
        return "revision-1";
      }
    };

    await persistProjectAggregate(writer, snapshot);

    expect(snapshot.headRevision).toBe("revision-1");
  });

  it("fails closed when a runtime writer returns a non-committed revision", async () => {
    const snapshot = createSnapshot();
    const maliciousWriter = {
      saveProjectAggregate: async () => null
    } as unknown as ProjectSnapshotWriter;

    await expect(persistProjectAggregate(maliciousWriter, snapshot)).rejects.toMatchObject({
      code: "STORAGE_REVISION_INVALID"
    });
    expect(snapshot.headRevision).toBeNull();
  });
});
