import { describe, expect, it } from "vitest";

import { DomainError } from "../domain/errors.js";
import { createAsset, validateAssetPath } from "../services/asset-service.js";
import { TEST_ACTOR, createTestDependencies } from "./builders.js";

describe("asset service", () => {
  it("只允许 project_root + relative_path", () => {
    const deps = createTestDependencies();
    const result = createAsset({
      projectId: "project-1",
      workItemIds: ["work-item-1"],
      pathBase: "project_root",
      relativePath: "docs/product-exploration-baseline.md",
      actor: TEST_ACTOR,
      deps
    });

    expect(result.asset.pathBase).toBe("project_root");
    expect(result.asset.relativePath).toBe("docs/product-exploration-baseline.md");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.targetType).toBe("asset");
    expect(result.events[0]?.eventType).toBe("asset.created");
  });

  it("拒绝绝对路径和平台路径分隔符", () => {
    expect(() => validateAssetPath("project_root", "/tmp/a.md")).toThrow(DomainError);
    expect(() => validateAssetPath("project_root", "C:\\tmp\\a.md")).toThrow(
      DomainError
    );
    expect(() => validateAssetPath("project_root", "docs\\a.md")).toThrow(DomainError);
  });
});
