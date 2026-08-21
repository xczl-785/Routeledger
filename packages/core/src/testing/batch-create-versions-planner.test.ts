import { describe, expect, it } from "vitest";

import type { ProjectAggregateSnapshot } from "../ports/storage-port.js";
import { evaluateBatchCreateVersions } from "../application/batch-create-versions-planner.js";
import { createProjectFixture, createVersionFixture } from "./builders.js";

describe("batch create versions planner", () => {
  it("returns the normalized plan payload without owning digest construction", () => {
    const snapshot: ProjectAggregateSnapshot = {
      project: createProjectFixture(),
      versions: [createVersionFixture({ isCurrent: true })],
      workItems: [],
      todos: [],
      undos: [],
      deferredItems: [],
      constraints: [],
      assets: [],
      events: [],
      pendingOperations: [],
      approvalArtifacts: [],
      ordinaryWriteReceipts: []
    };

    const result = evaluateBatchCreateVersions(
      snapshot,
      {
        anchor: { afterVersionId: "version-1" },
        items: [
          {
            clientKey: "next",
            title: "Next version",
            description: "planned delivery",
            initialTodos: ["Review plan"]
          }
        ],
        setCurrentTo: "next",
        previousCurrentPolicy: "leave_as_is"
      },
      "2026-06-27T01:00:00.000Z",
      "snapshot-hash"
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected planner success");

    expect(result.normalizedPlan).toMatchObject({
      partialAllowed: false,
      setCurrentTo: "next",
      previousCurrentPolicy: "leave_as_is"
    });
    expect(result.preview.createdVersions).toEqual([
      expect.objectContaining({
        clientKey: "next",
        previewVersionId: "batch-preview:0:next",
        previousRef: "version-1"
      })
    ]);
    expect(result.payload.batchPreflightSnapshotHash).toBe("snapshot-hash");
    expect(result).not.toHaveProperty("digestPreview");
  });
});
