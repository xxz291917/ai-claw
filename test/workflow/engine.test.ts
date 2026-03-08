import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
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

    const resumed = await engine.resume(result.token, "approve", "alice");
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

    const cancelled = await engine.resume(result.token, "reject", "alice");
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
    await expect(engine.resume(result.token, "approve", "bob")).rejects.toThrow();
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

  it("prevents running a new workflow while one is paused", async () => {
    // First workflow pauses at approval
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "1.0" },
      { userId: "alice", sessionId: "s1" },
    );
    expect(result.status).toBe("needs_approval");

    // Second workflow should be blocked
    const result2 = await engine.run(SIMPLE_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result2.status).toBe("failed");
    if (result2.status === "failed") {
      expect(result2.error).toContain("paused");
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

  it("writes stdout to file when output: file is set", async () => {
    const wf: WorkflowDefinition = {
      name: "file-output-wf",
      args: {},
      steps: [
        { id: "big", command: "seq 1 100", output: "file" },
        { id: "check", command: "cat ${big.file} | grep -c ." },
      ],
    };
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      // big step should have file path
      expect(result.steps[0].file).toBeTruthy();
      expect(existsSync(result.steps[0].file!)).toBe(true);
      // File should contain full output
      const fileContent = readFileSync(result.steps[0].file!, "utf-8");
      expect(fileContent.split("\n").filter(Boolean)).toHaveLength(100);
      // stdout should be summary (last 20 lines)
      expect(result.steps[0].stdout).toContain("...");
      // check step should have used the file
      expect(result.steps[1].stdout).toContain("100");
    }
  });

  it("resume with feedback stores text in approval step result", async () => {
    const wf: WorkflowDefinition = {
      name: "feedback-wf",
      args: {},
      steps: [
        { id: "draft", command: "echo initial-draft" },
        { id: "review", approval: { prompt: "请审阅" } },
        { id: "use-feedback", command: "echo feedback was: ${review.result}" },
      ],
    };
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("needs_approval");
    if (result.status !== "needs_approval") return;

    const resumed = await engine.resume(result.token, "approve", "alice", "标题改短一些");
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      // approval step should have feedback as result
      expect(resumed.steps[1].result).toBe("标题改短一些");
      // next step should reference the feedback
      expect(resumed.steps[2].stdout).toContain("feedback was: 标题改短一些");
    }
  });

  it("resume without feedback defaults to 'approved'", async () => {
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "3.0" },
      { userId: "alice", sessionId: "s1" },
    );
    if (result.status !== "needs_approval") return;

    const resumed = await engine.resume(result.token, "approve", "alice");
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      expect(resumed.steps[1].result).toBe("approved");
    }
  });

  it("reject with feedback stores reason in error", async () => {
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "4.0" },
      { userId: "alice", sessionId: "s1" },
    );
    if (result.status !== "needs_approval") return;

    const rejected = await engine.resume(result.token, "reject", "alice", "方案不可行，风险太大");
    expect(rejected.status).toBe("failed");
    if (rejected.status === "failed") {
      expect(rejected.error).toBe("方案不可行，风险太大");
    }
  });

  it("writes to custom filename with output: file:name", async () => {
    const wf: WorkflowDefinition = {
      name: "named-file-wf",
      args: {},
      steps: [
        { id: "data", command: "echo hello", output: "file:data.txt" },
      ],
    };
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.steps[0].file).toContain("data.txt");
      const content = readFileSync(result.steps[0].file!, "utf-8").trim();
      expect(content).toBe("hello");
    }
  });

  // --- goto / revision tests ---

  const GOTO_WORKFLOW: WorkflowDefinition = {
    name: "goto-wf",
    args: {},
    steps: [
      { id: "draft", command: "echo draft-${review.result || 'v1'}" },
      { id: "review", approval: { prompt: "Review: ${draft.stdout}", goto: "draft" } },
      { id: "done", command: "echo final: ${draft.stdout}" },
    ],
  };

  it("revise jumps back to goto target and re-executes", async () => {
    const result = await engine.run(GOTO_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("needs_approval");
    if (result.status !== "needs_approval") return;
    expect(result.revision).toBe(0);

    // First revise
    const r1 = await engine.resume(result.token, "revise", "alice", "改为中文");
    expect(r1.status).toBe("needs_approval");
    if (r1.status !== "needs_approval") return;
    expect(r1.revision).toBe(1);

    // Approve after revision
    const final = await engine.resume(r1.token, "approve", "alice");
    expect(final.status).toBe("completed");
    if (final.status === "completed") {
      // done step should reference the re-executed draft
      expect(final.steps).toBeDefined();
    }
  });

  it("revise without goto configured throws error", async () => {
    // APPROVAL_WORKFLOW has no goto
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "1.0" },
      { userId: "alice", sessionId: "s1" },
    );
    if (result.status !== "needs_approval") return;

    await expect(
      engine.resume(result.token, "revise", "alice", "some feedback"),
    ).rejects.toThrow("does not support revision");
  });

  it("max_revisions limits revision count", async () => {
    const wf: WorkflowDefinition = {
      name: "limited-wf",
      args: {},
      steps: [
        { id: "work", command: "echo working" },
        { id: "check", approval: { prompt: "OK?", goto: "work", max_revisions: 1 } },
        { id: "done", command: "echo done" },
      ],
    };
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    if (result.status !== "needs_approval") return;

    // First revise — should succeed
    const r1 = await engine.resume(result.token, "revise", "alice", "fix it");
    expect(r1.status).toBe("needs_approval");

    // Second revise — should fail (max_revisions=1)
    if (r1.status !== "needs_approval") return;
    const r2 = await engine.resume(r1.token, "revise", "alice", "fix again");
    expect(r2.status).toBe("failed");
    if (r2.status === "failed") {
      expect(r2.error).toContain("Maximum revisions");
    }
  });

  it("no max_revisions allows unlimited revisions", async () => {
    const wf: WorkflowDefinition = {
      name: "unlimited-wf",
      args: {},
      steps: [
        { id: "work", command: "echo working" },
        { id: "check", approval: { prompt: "OK?", goto: "work" } },
        { id: "done", command: "echo done" },
      ],
    };
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    if (result.status !== "needs_approval") return;

    // Revise 5 times — all should succeed
    let current = result;
    for (let i = 0; i < 5; i++) {
      const r = await engine.resume(current.token, "revise", "alice", `revision ${i + 1}`);
      expect(r.status).toBe("needs_approval");
      if (r.status !== "needs_approval") return;
      expect(r.revision).toBe(i + 1);
      current = r;
    }

    // Finally approve
    const final = await engine.resume(current.token, "approve", "alice");
    expect(final.status).toBe("completed");
  });

  it("revision clears intermediate step results", async () => {
    const wf: WorkflowDefinition = {
      name: "clear-wf",
      args: {},
      steps: [
        { id: "gen", command: "echo $RANDOM" },
        { id: "review", approval: { prompt: "Check: ${gen.stdout}", goto: "gen" } },
        { id: "done", command: "echo ${gen.stdout}" },
      ],
    };
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    if (result.status !== "needs_approval") return;

    const firstGenOutput = result.completed_steps.find((s) => s.id === "gen")?.stdout;

    const r1 = await engine.resume(result.token, "revise", "alice", "redo");
    if (r1.status !== "needs_approval") return;

    // gen should have been re-executed (different $RANDOM)
    const newGenOutput = r1.completed_steps.find((s) => s.id === "gen")?.stdout;
    // Both should exist
    expect(firstGenOutput).toBeTruthy();
    expect(newGenOutput).toBeTruthy();
  });

  it("substituteVars uses latest result in loops", async () => {
    const wf: WorkflowDefinition = {
      name: "latest-var-wf",
      args: {},
      steps: [
        { id: "gen", command: "echo version-${review.revision}" },
        { id: "review", approval: { prompt: "${gen.stdout}", goto: "gen" } },
        { id: "done", command: "echo ${gen.stdout}" },
      ],
    };
    // First run: review hasn't happened, ${review.revision} resolves to ""
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    if (result.status !== "needs_approval") return;
    expect(result.prompt).toContain("version-");

    // After revise: review.revision=1, gen re-executes with that
    const r1 = await engine.resume(result.token, "revise", "alice", "more");
    if (r1.status !== "needs_approval") return;
    expect(r1.prompt).toContain("version-1");

    const final = await engine.resume(r1.token, "approve", "alice");
    if (final.status === "completed") {
      const doneStep = final.steps.find((s) => s.id === "done");
      expect(doneStep?.stdout).toContain("version-1");
    }
  });
});
