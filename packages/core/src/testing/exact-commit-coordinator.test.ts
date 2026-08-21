import { describe, expect, it, vi } from "vitest";

import {
  MemoryExactCommitCoordinator,
  type ExactCommitCoordinatorState,
  type ExactCommitOwnerIdentity
} from "../application/exact-commit-coordinator.js";

describe("MemoryExactCommitCoordinator", () => {
  it("takes over an expired lease from a confirmed-dead owner with the next generation", async () => {
    const commitKey = "project-1/pending-operation-1";
    const deadOwner: ExactCommitOwnerIdentity = {
      attemptId: "attempt-1",
      processId: 101,
      processStartedAt: "2026-08-21T08:00:00.000Z",
      instanceId: "instance-1"
    };
    const state: ExactCommitCoordinatorState = {
      records: {
        [commitKey]: {
          commitKey,
          owner: deadOwner,
          generation: 1,
          leaseExpiresAt: "2026-08-21T08:01:00.000Z",
          status: "owned",
          releasedAt: null
        }
      }
    };
    const resolveOwnerLiveness = vi.fn(async () => "dead" as const);
    const coordinator = new MemoryExactCommitCoordinator({
      state,
      now: () => "2026-08-21T08:02:00.000Z",
      resolveOwnerLiveness
    });

    const acquired = await coordinator.acquire({
      commitKey,
      owner: {
        attemptId: "attempt-2",
        processId: 202,
        processStartedAt: "2026-08-21T08:01:30.000Z",
        instanceId: "instance-2"
      },
      leaseDurationMs: 30_000
    });

    expect(resolveOwnerLiveness).toHaveBeenCalledOnce();
    expect(resolveOwnerLiveness).toHaveBeenCalledWith(deadOwner);
    expect(acquired).toMatchObject({
      ok: true,
      token: {
        commitKey,
        owner: { attemptId: "attempt-2" },
        generation: 2
      }
    });
  });

  it.each([
    ["alive", "COMMIT_OWNED_BY_LIVE_PROCESS"],
    ["unknown", "COMMIT_OWNER_LIVENESS_UNKNOWN"]
  ] as const)("fails closed when an expired owner's liveness is %s", async (liveness, code) => {
    const commitKey = "project-1/pending-operation-1";
    const coordinator = new MemoryExactCommitCoordinator({
      state: {
        records: {
          [commitKey]: {
            commitKey,
            owner: {
              attemptId: "attempt-1",
              processId: 101,
              processStartedAt: "2026-08-21T08:00:00.000Z",
              instanceId: "instance-1"
            },
            generation: 1,
            leaseExpiresAt: "2026-08-21T08:01:00.000Z",
            status: "owned",
            releasedAt: null
          }
        }
      },
      now: () => "2026-08-21T08:02:00.000Z",
      resolveOwnerLiveness: async () => liveness
    });

    await expect(
      coordinator.acquire({
        commitKey,
        owner: {
          attemptId: "attempt-2",
          processId: 202,
          processStartedAt: "2026-08-21T08:01:30.000Z",
          instanceId: "instance-2"
        },
        leaseDurationMs: 30_000
      })
    ).resolves.toEqual({ ok: false, code });
    expect(coordinator.exportState().records[commitKey]).toMatchObject({
      owner: { attemptId: "attempt-1" },
      generation: 1,
      status: "owned"
    });
  });

  it("does not let a previous generation release the replacement owner", async () => {
    const commitKey = "project-1/pending-operation-1";
    const oldToken = {
      commitKey,
      owner: {
        attemptId: "attempt-1",
        processId: 101,
        processStartedAt: "2026-08-21T08:00:00.000Z",
        instanceId: "instance-1"
      },
      generation: 1,
      leaseExpiresAt: "2026-08-21T08:01:00.000Z",
      status: "owned" as const,
      releasedAt: null
    };
    const coordinator = new MemoryExactCommitCoordinator({
      state: { records: { [commitKey]: oldToken } },
      now: () => "2026-08-21T08:02:00.000Z",
      resolveOwnerLiveness: async () => "dead"
    });

    await coordinator.acquire({
      commitKey,
      owner: {
        attemptId: "attempt-2",
        processId: 202,
        processStartedAt: "2026-08-21T08:01:30.000Z",
        instanceId: "instance-2"
      },
      leaseDurationMs: 30_000
    });
    await coordinator.release(oldToken);

    expect(coordinator.exportState()).toMatchObject({
      records: {
        [commitKey]: {
          owner: { attemptId: "attempt-2" },
          generation: 2,
          status: "owned"
        }
      }
    });
  });

  it("retains the generation after an owner-checked release", async () => {
    const commitKey = "project-1/pending-operation-1";
    const coordinator = new MemoryExactCommitCoordinator({
      now: () => "2026-08-21T08:00:00.000Z",
      resolveOwnerLiveness: async () => "unknown"
    });
    const first = await coordinator.acquire({
      commitKey,
      owner: {
        attemptId: "attempt-1",
        processId: 101,
        processStartedAt: "2026-08-21T07:59:00.000Z",
        instanceId: "instance-1"
      },
      leaseDurationMs: 30_000
    });
    if (!first.ok) throw new Error(`Expected first ownership: ${first.code}`);

    await coordinator.release(first.token);

    expect(coordinator.exportState()).toMatchObject({
      records: {
        [commitKey]: {
          generation: 1,
          status: "released",
          releasedAt: "2026-08-21T08:00:00.000Z"
        }
      }
    });
  });

  it("allows only one concurrent attempt to take over the same dead owner", async () => {
    const commitKey = "project-1/pending-operation-1";
    let reportDead!: (value: "dead") => void;
    const deadLiveness = new Promise<"dead">((resolve) => {
      reportDead = resolve;
    });
    const resolveOwnerLiveness = vi.fn(() => deadLiveness);
    const coordinator = new MemoryExactCommitCoordinator({
      state: {
        records: {
          [commitKey]: {
            commitKey,
            owner: {
              attemptId: "attempt-1",
              processId: 101,
              processStartedAt: "2026-08-21T08:00:00.000Z",
              instanceId: "instance-1"
            },
            generation: 1,
            leaseExpiresAt: "2026-08-21T08:01:00.000Z",
            status: "owned",
            releasedAt: null
          }
        }
      },
      now: () => "2026-08-21T08:02:00.000Z",
      resolveOwnerLiveness
    });
    const acquire = (attemptId: string, processId: number) =>
      coordinator.acquire({
        commitKey,
        owner: {
          attemptId,
          processId,
          processStartedAt: "2026-08-21T08:01:30.000Z",
          instanceId: `instance-${processId}`
        },
        leaseDurationMs: 30_000
      });

    const attempts = [acquire("attempt-2", 202), acquire("attempt-3", 303)];
    await vi.waitFor(() => expect(resolveOwnerLiveness).toHaveBeenCalledTimes(2));
    reportDead("dead");
    const results = await Promise.all(attempts);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.ok)[0]).toMatchObject({
      token: { generation: 2 }
    });
  });

  it("fences the old token and renews only the replacement token", async () => {
    const commitKey = "project-1/pending-operation-1";
    const oldToken = {
      commitKey,
      owner: {
        attemptId: "attempt-1",
        processId: 101,
        processStartedAt: "2026-08-21T08:00:00.000Z",
        instanceId: "instance-1"
      },
      generation: 1,
      leaseExpiresAt: "2026-08-21T08:01:00.000Z",
      status: "owned" as const,
      releasedAt: null
    };
    const coordinator = new MemoryExactCommitCoordinator({
      state: { records: { [commitKey]: oldToken } },
      now: () => "2026-08-21T08:02:00.000Z",
      resolveOwnerLiveness: async () => "dead"
    });
    const takeover = await coordinator.acquire({
      commitKey,
      owner: {
        attemptId: "attempt-2",
        processId: 202,
        processStartedAt: "2026-08-21T08:01:30.000Z",
        instanceId: "instance-2"
      },
      leaseDurationMs: 30_000
    });
    if (!takeover.ok) throw new Error(`Expected takeover: ${takeover.code}`);

    await expect(coordinator.assertOwned(oldToken)).resolves.toBe(false);
    await expect(coordinator.assertOwned(takeover.token)).resolves.toBe(true);
    await expect(coordinator.renew(oldToken, 60_000)).resolves.toEqual({
      ok: false,
      code: "COMMIT_OWNERSHIP_LOST"
    });
    await expect(coordinator.renew(takeover.token, 60_000)).resolves.toMatchObject({
      ok: true,
      token: {
        generation: 2,
        leaseExpiresAt: "2026-08-21T08:03:00.000Z"
      }
    });
  });
});
