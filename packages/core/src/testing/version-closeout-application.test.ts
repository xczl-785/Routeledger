import { describe, expect, it } from "vitest";

import { createProjectFixture } from "./builders.js";
import {
  planVersionCloseoutApplication,
  summarizeVersionCloseoutApplication
} from "../application/version-closeout-application.js";

const createEmptyRouteSnapshot = () => ({
  project: createProjectFixture({ currentVersionId: null }),
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

describe("version closeout application", () => {
  it("preserves the shared missing-current error contract for summary and plan", () => {
    const snapshot = createEmptyRouteSnapshot();

    for (const operation of [
      () => summarizeVersionCloseoutApplication(snapshot, { projectId: "project-1" }),
      () => planVersionCloseoutApplication(snapshot, { projectId: "project-1" })
    ]) {
      expect(operation).toThrowError(
        expect.objectContaining({
          name: "ApplicationError",
          code: "VERSION_NOT_FOUND",
          details: { projectId: "project-1" }
        })
      );
    }
  });
});
