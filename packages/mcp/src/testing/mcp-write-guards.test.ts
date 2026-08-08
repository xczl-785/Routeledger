import fs from "node:fs";

import { expect, it, describe } from "vitest";

import { readRouteLedgerJsonDocuments } from "../../../json/src/index.js";
import { createRouteLedgerMcpRegistry } from "../index.js";

import { createTempProjectRoot, getDefaultDataRoot, getDefaultJsonProjectPath, createMismatchedExpectedRouteLedgerRoot, createRegistry, cleanupProjectRoot, expectRouteLedgerRootGuardError, createApprovedVersionProposal } from "./mcp-test-helpers.js";
describe("routeledger mcp registry", () => {
  it("write tools reject invalid relative expectedRouteLedgerRoot before mutating state", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: "relative/path"
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_EXPECTED_ROUTELEDGER_ROOT_INVALID",
        projectRoot,
        "init_project"
      );
      expect(response.error?.details).toMatchObject({
        expectedRouteLedgerRoot: "relative/path",
        receivedType: "string",
        receivedValue: "relative/path"
      });
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("matched expectedRouteLedgerRoot allows write tools to proceed", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);

    try {
      const response = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });

      expect(response.ok).toBe(true);
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("dry-run route workflows retain the root assertion before previewing live state", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRouteLedgerMcpRegistry({
      workspaceRoot: projectRoot,
      routeledgerRoot: projectRoot
    });

    try {
      const initialized = await registry.invoke("init_project", {
        name: "RouteLedger",
        contentLocale: "en",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initialized.ok).toBe(true);
      const data = initialized.data as {
        project: { id: string };
        initialVersion: { id: string };
      };

      const dryRunInputs: Array<{
        toolName: "transition_version" | "close_version" | "shutdown_version";
        input: Record<string, unknown>;
      }> = [
        {
          toolName: "transition_version",
          input: { projectId: data.project.id, versionId: data.initialVersion.id, mode: "dry_run" }
        },
        {
          toolName: "close_version",
          input: { projectId: data.project.id, versionId: data.initialVersion.id, mode: "dry_run" }
        },
        {
          toolName: "shutdown_version",
          input: {
            projectId: data.project.id,
            versionId: data.initialVersion.id,
            mode: "dry_run",
            shutdownReason: "test forced-path preview"
          }
        }
      ];

      for (const { toolName, input } of dryRunInputs) {
        const response = await registry.invoke(toolName, input);
        expectRouteLedgerRootGuardError(
          response,
          "ROUTELEDGER_WRITE_BINDING_ASSERTION_REQUIRED",
          projectRoot,
          toolName
        );
      }
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks init_project before creating canonical JSON", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const response = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "init_project"
      );
      expect(response.error?.details).toMatchObject({
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });
      expect(fs.existsSync(getDefaultJsonProjectPath(projectRoot))).toBe(false);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks create_todo without changing canonical JSON", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      };
      const baselineDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(projectRoot));

      const response = await registry.invoke("create_todo", {
        projectId: initData.project.id,
        versionId: initData.initialVersion.id,
        title: "write docs",
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "create_todo"
      );
      const updatedDocuments = await readRouteLedgerJsonDocuments(getDefaultDataRoot(projectRoot));
      expect(updatedDocuments).toEqual(baselineDocuments);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks create_version without creating pending proposals", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };

      const response = await registry.invoke("create_version", {
        projectId: initData.project.id,
        title: "Version 2",
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "create_version"
      );
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([]);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks commit_l3_operation without consuming approval artifacts", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };
      const approvedProposal = await createApprovedVersionProposal(
        registry,
        initData.project.id,
        "Version 2",
        projectRoot
      );

      const response = await registry.invoke("commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: approvedProposal.pendingOperationId,
        approvalArtifactId: approvedProposal.approvalArtifactId,
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "commit_l3_operation"
      );
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([
        expect.objectContaining({
          id: approvedProposal.pendingOperationId,
          status: "pending"
        })
      ]);

      const retryResponse = await registry.invoke("commit_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId: approvedProposal.pendingOperationId,
        approvalArtifactId: approvedProposal.approvalArtifactId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(retryResponse.ok).toBe(true);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks approve_l3_operation while proposal stays pending", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };

      const createVersionResponse = await registry.invoke("create_version", {
        projectId: initData.project.id,
        title: "Version 2",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(createVersionResponse).toMatchObject({
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED"
        }
      });
      const pendingOperationId = (
        createVersionResponse.error?.details as {
          pendingOperationId: string;
        }
      ).pendingOperationId;

      const response = await registry.invoke("approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "approve_l3_operation"
      );
      expect(response.ok).toBe(false);
      expect(response.data).toBeUndefined();
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([
        expect.objectContaining({
          id: pendingOperationId,
          status: "pending"
        })
      ]);

      const retryResponse = await registry.invoke("approve_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        expectedRouteLedgerRoot: projectRoot
      });
      expect(retryResponse.ok).toBe(true);
      expect(retryResponse.data).toEqual(
        expect.objectContaining({
          id: expect.any(String)
        })
      );
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks reject_l3_operation while proposal stays pending", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
      };

      const createVersionResponse = await registry.invoke("create_version", {
        projectId: initData.project.id,
        title: "Version 2",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(createVersionResponse).toMatchObject({
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED"
        }
      });
      const pendingOperationId = (
        createVersionResponse.error?.details as {
          pendingOperationId: string;
        }
      ).pendingOperationId;

      const response = await registry.invoke("reject_l3_operation", {
        projectId: initData.project.id,
        pendingOperationId,
        reason: "reject after mismatch guard test",
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "reject_l3_operation"
      );
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([
        expect.objectContaining({
          id: pendingOperationId,
          status: "pending"
        })
      ]);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

  it("mismatched expectedRouteLedgerRoot blocks batch_create_versions without creating pending proposals", async () => {
    const projectRoot = createTempProjectRoot();
    const registry = createRegistry(projectRoot);
    const mismatchedProjectRoot = createMismatchedExpectedRouteLedgerRoot(projectRoot);

    try {
      const initResponse = await registry.invoke("init_project", {
        name: "RouteLedger",
        expectedRouteLedgerRoot: projectRoot
      });
      expect(initResponse.ok).toBe(true);
      const initData = initResponse.data as {
        project: { id: string };
        initialVersion: { id: string };
      };

      const response = await registry.invoke("batch_create_versions", {
        projectId: initData.project.id,
        mode: "propose",
        anchor: {
          afterVersionId: initData.initialVersion.id
        },
        items: [
          {
            clientKey: "plan-a",
            title: "Plan A",
            description: "batch item A",
            initialTodos: []
          }
        ],
        expectedRouteLedgerRoot: mismatchedProjectRoot
      });

      expectRouteLedgerRootGuardError(
        response,
        "MCP_ROUTELEDGER_ROOT_MISMATCH",
        projectRoot,
        "batch_create_versions"
      );
      const proposalsResponse = await registry.invoke("list_l3_proposals", {
        projectId: initData.project.id
      });
      expect(proposalsResponse.ok).toBe(true);
      expect(proposalsResponse.data).toEqual([]);
    } finally {
      registry.close();
      cleanupProjectRoot(projectRoot);
    }
  });

});
