import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { createTestDb } from "../helpers.js";
import type { WorkflowDefinition } from "../../src/workflow/types.js";
import type Database from "better-sqlite3";

const SIMPLE_WORKFLOW: WorkflowDefinition = {
  name: "test-wf",
  args: {},
  steps: [
    { id: "echo", command: "echo hello" },
  ],
};

const APPROVAL_WORKFLOW: WorkflowDefinition = {
  name: "approval-wf",
  args: { version: { required: true } },
  steps: [
    { id: "check", command: "echo ok" },
    { id: "confirm", approval: { prompt: "Deploy v${version}?" } },
    { id: "deploy", command: "echo deployed" },
  ],
};

const EXPECT_WORKFLOW: WorkflowDefinition = {
  name: "expect-wf",
  args: {},
  steps: [
    { id: "branch", command: "echo main", expect: "main" },
  ],
};

const EXPECT_FAIL_WORKFLOW: WorkflowDefinition = {
  name: "expect-fail-wf",
  args: {},
  steps: [
    { id: "branch", command: "echo develop", expect: "main" },
  ],
};

describe("WorkflowEngine", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new WorkflowEngine({ db });
  });

  it("runs a simple command workflow to completion", async () => {
    const result = await engine.run(SIMPLE_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].ok).toBe(true);
      expect(result.steps[0].stdout).toContain("hello");
    }
  });

  it("pauses at approval gate and resumes", async () => {
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "1.0" },
      { userId: "alice", sessionId: "s1" },
    );
    expect(result.status).toBe("needs_approval");
    if (result.status !== "needs_approval") return;
    expect(result.prompt).toBe("Deploy v1.0?");
    expect(result.token).toBeTruthy();
    expect(result.completed_steps).toHaveLength(1);

    const resumed = await engine.resume(result.token, true, "alice");
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      expect(resumed.steps).toHaveLength(3);
    }
  });

  it("cancels workflow on resume with approve=false", async () => {
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "2.0" },
      { userId: "alice", sessionId: "s1" },
    );
    if (result.status !== "needs_approval") return;

    const cancelled = await engine.resume(result.token, false, "alice");
    expect(cancelled.status).toBe("failed");
    if (cancelled.status === "failed") {
      expect(cancelled.failed_step).toBe("confirm");
    }
  });

  it("rejects resume with wrong userId", async () => {
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "1.0" },
      { userId: "alice", sessionId: "s1" },
    );
    if (result.status !== "needs_approval") return;
    await expect(engine.resume(result.token, true, "bob")).rejects.toThrow();
  });

  it("validates expect field", async () => {
    const result = await engine.run(EXPECT_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("completed");
  });

  it("fails when expect does not match", async () => {
    const result = await engine.run(EXPECT_FAIL_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failed_step).toBe("branch");
    }
  });

  it("substitutes ${arg} and ${step.stdout} variables", async () => {
    const wf: WorkflowDefinition = {
      name: "vars-wf",
      args: { name: { required: true } },
      steps: [
        { id: "greet", command: "echo hello-${name}" },
        { id: "use", command: "echo ${greet.stdout}" },
      ],
    };
    const result = await engine.run(wf, { name: "world" }, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.steps[0].stdout).toContain("hello-world");
      expect(result.steps[1].stdout).toContain("hello-world");
    }
  });

  it("listByUser returns active workflows", async () => {
    const APPROVAL_WF: WorkflowDefinition = {
      name: "approval-wf",
      args: { version: { required: true } },
      steps: [
        { id: "check", command: "echo ok" },
        { id: "confirm", approval: { prompt: "Deploy v${version}?" } },
        { id: "deploy", command: "echo deployed" },
      ],
    };
    const result = await engine.run(
      APPROVAL_WF,
      { version: "2.0" },
      { userId: "alice", sessionId: "s1" },
    );
    expect(result.status).toBe("needs_approval");

    const list = engine.listByUser("alice");
    expect(list).toHaveLength(1);
    expect(list[0].workflowName).toBe("approval-wf");
    expect(list[0].status).toBe("paused");

    // Other user sees nothing
    const otherList = engine.listByUser("bob");
    expect(otherList).toHaveLength(0);
  });

  it("prevents running a second workflow while one is running", async () => {
    // Insert a running record directly
    db.prepare(
      "INSERT INTO workflow_executions (id, workflow_name, user_id, session_id, status, args, step_results) VALUES (?, ?, ?, ?, 'running', '{}', '[]')",
    ).run("wf_existing", "other-wf", "alice", "s1");

    const result = await engine.run(SIMPLE_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("already running");
    }
  });

  it("fails on command exit code != 0", async () => {
    const wf: WorkflowDefinition = {
      name: "fail-wf",
      args: {},
      steps: [{ id: "bad", command: "exit 1" }],
    };
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failed_step).toBe("bad");
    }
  });
});
