import { describe, expect, it } from "vitest";

import {
  buildCanonicalIdDocumentPath,
  buildTransitionEventDocumentPath,
  CANONICAL_DOCUMENT_DESCRIPTORS,
  matchCanonicalDocumentDescriptor,
  matchRouteLedgerDocumentContract
} from "../document-descriptors.js";
import { buildRouteLedgerSchemaDocument } from "../schema.js";

describe("canonical JSON document descriptors", () => {
  it("drives the ordered schema manifest and validator document contracts from one set", () => {
    expect(CANONICAL_DOCUMENT_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual([
      "project",
      "current_ref",
      "schema",
      "version",
      "work_item",
      "todo",
      "undo",
      "deferred_item",
      "constraint",
      "asset",
      "transition_event",
      "pending_operation",
      "approval_artifact",
      "ordinary_write_receipt"
    ]);

    const schemaManifest = JSON.parse(buildRouteLedgerSchemaDocument().content) as {
      documents: Array<{ kind: string; path_pattern: string }>;
    };
    expect(schemaManifest.documents).toEqual(
      CANONICAL_DOCUMENT_DESCRIPTORS
        .filter((descriptor) => descriptor.includeInSchemaManifest)
        .map((descriptor) => ({
          kind: descriptor.kind,
          path_pattern: descriptor.pathPattern
        }))
    );

    expect(matchCanonicalDocumentDescriptor(".routeledger/project.json")).toMatchObject({
      id: "project",
      kind: "project",
      requireSchemaVersion: true
    });
    expect(matchCanonicalDocumentDescriptor(".routeledger/refs/current.json")).toMatchObject({
      id: "current_ref",
      kind: "current_ref",
      requireSchemaVersion: true
    });
    expect(
      matchCanonicalDocumentDescriptor(".routeledger/versions/ve/version-1.json")
    ).toMatchObject({
      id: "version",
      kind: "version",
      requireSchemaVersion: true
    });
    const schemaDescriptor = matchCanonicalDocumentDescriptor(
      ".routeledger/schema/routeledger.schema.json"
    );
    expect(schemaDescriptor).toMatchObject({
      id: "schema",
      requireSchemaVersion: true
    });
    expect(schemaDescriptor?.kind).toBeUndefined();

    const malformedVersionPath = ".routeledger/versions/not-canonical";
    expect(matchCanonicalDocumentDescriptor(malformedVersionPath)).toBeUndefined();
    expect(matchRouteLedgerDocumentContract(malformedVersionPath)).toMatchObject({
      id: "version",
      kind: "version",
      requireSchemaVersion: true
    });

    expect(buildCanonicalIdDocumentPath("version", "v1")).toBe(
      ".routeledger/versions/v1/v1.json"
    );
    expect(buildCanonicalIdDocumentPath("todo", "x")).toBe(
      ".routeledger/todos/x_/x.json"
    );
    expect(
      buildTransitionEventDocumentPath({
        id: "event-1",
        createdAt: "2026-08-21T12:00:00.000Z"
      })
    ).toBe(".routeledger/events/2026/08/event-1.json");
    expect(
      buildTransitionEventDocumentPath({ id: "event-1", createdAt: "invalid" })
    ).toBeUndefined();
  });
});
