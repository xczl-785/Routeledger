import { describe, expect, it } from "vitest";

import { DomainError } from "../domain/errors.js";
import { evaluateCloseGate, evaluateStartGate } from "../services/gate-service.js";
import { createDomainContext } from "../services/operation.js";
import {
  closeVersion,
  markVersionComplete,
  prepareVersion,
  reopenVersion,
  startVersion,
  suspendVersion
} from "../services/version-service.js";
import {
  TEST_ACTOR,
  createTestDependencies,
  createTodoFixture,
  createUndoFixture,
  createVersionFixture
} from "./builders.js";

describe("version service", () => {
  it("支持 wait -> ready -> running -> complete -> close", () => {
    const deps = createTestDependencies();
    const context = createDomainContext(deps, TEST_ACTOR);
    const ready = prepareVersion(createVersionFixture(), context, deps).version;
    const gate = evaluateStartGate({
      targetVersion: ready,
      currentVersionTodos: [],
      dueUndos: []
    });
    const running = startVersion(ready, gate, context, deps).version;
    const complete = markVersionComplete(running, context, deps).version;
    const closeGate = evaluateCloseGate({
      version: complete,
      todos: [],
      undos: [],
      residualAudit: [
        {
          kind: "bug",
          summary: "none",
          destination: "close"
        }
      ]
    });
    const closed = closeVersion(complete, closeGate, context, deps).version;

    expect(ready.state).toBe("ready");
    expect(running.state).toBe("running");
    expect(complete.state).toBe("complete");
    expect(closed.state).toBe("close");
  });

  it("不允许 wait -> running 跳过 prepare_version", () => {
    const deps = createTestDependencies();
    const context = createDomainContext(deps, TEST_ACTOR);
    const gate = evaluateStartGate({
      targetVersion: createVersionFixture(),
      currentVersionTodos: [],
      dueUndos: []
    });

    expect(() => startVersion(createVersionFixture(), gate, context, deps)).toThrow(
      DomainError
    );
  });

  it("ready -> running 必须通过 start gate", () => {
    const deps = createTestDependencies();
    const context = createDomainContext(deps, TEST_ACTOR);
    const readyVersion = createVersionFixture({
      state: "ready"
    });
    const gate = evaluateStartGate({
      targetVersion: readyVersion,
      currentVersionTodos: [],
      dueUndos: [createUndoFixture({ preferredResolutionVersionId: readyVersion.id })]
    });

    expect(() => startVersion(readyVersion, gate, context, deps)).toThrow(DomainError);
  });

  it("支持 suspend -> ready -> running", () => {
    const deps = createTestDependencies();
    const context = createDomainContext(deps, TEST_ACTOR);
    const running = createVersionFixture({
      state: "running"
    });
    const suspended = suspendVersion(running, context, deps).version;
    const reopened = reopenVersion(suspended, context, deps).version;
    const gate = evaluateStartGate({
      targetVersion: reopened,
      currentVersionTodos: [],
      dueUndos: []
    });
    const restarted = startVersion(reopened, gate, context, deps).version;

    expect(suspended.state).toBe("suspend");
    expect(reopened.state).toBe("ready");
    expect(restarted.state).toBe("running");
  });

  it("支持 close --reopen--> ready", () => {
    const deps = createTestDependencies();
    const context = createDomainContext(deps, TEST_ACTOR);
    const reopened = reopenVersion(
      createVersionFixture({
        state: "close"
      }),
      context,
      deps
    ).version;

    expect(reopened.state).toBe("ready");
  });

  it("complete -> close 必须通过 close gate", () => {
    const deps = createTestDependencies();
    const context = createDomainContext(deps, TEST_ACTOR);
    const completeVersion = createVersionFixture({
      state: "complete"
    });
    const gate = evaluateCloseGate({
      version: completeVersion,
      todos: [createTodoFixture()],
      undos: [],
      residualAudit: null
    });

    expect(() => closeVersion(completeVersion, gate, context, deps)).toThrow(
      DomainError
    );
  });

  it("不允许 complete -> suspend", () => {
    const deps = createTestDependencies();
    const context = createDomainContext(deps, TEST_ACTOR);

    expect(() =>
      suspendVersion(
        createVersionFixture({
          state: "complete"
        }),
        context,
        deps
      )
    ).toThrow(DomainError);
  });
});
