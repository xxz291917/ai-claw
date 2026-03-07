import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWorkflowTools } from "../../src/workflow/tools.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { createTestDb } from "../helpers.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";

const SKILL_CONTENT = `---
name: echo-wf
description: Simple echo workflow
workflow:
  args:
    msg:
      required: true
  steps:
    - id: echo
      command: echo \${msg}
---
# Echo Workflow
`;

describe("createWorkflowTools", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = resolve("/tmp/wf-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(resolve(tmpDir, "echo-wf.md"), SKILL_CONTENT);
    engine = new WorkflowEngine({ db });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {}
  });

  it("creates run_workflow and resume_workflow tools", () => {
    const tools = createWorkflowTools(engine, [tmpDir]);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("run_workflow");
    expect(tools[1].name).toBe("resume_workflow");
  });

  it("run_workflow executes a simple workflow", async () => {
    const tools = createWorkflowTools(engine, [tmpDir]);
    const runTool = tools[0];
    const result = await runTool.execute(
      { workflow: "echo-wf", args: JSON.stringify({ msg: "hi" }) },
      { userId: "alice", sessionId: "s1" },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("completed");
    expect(parsed.steps[0].stdout).toContain("hi");
  });

  it("returns error for unknown workflow", async () => {
    const tools = createWorkflowTools(engine, [tmpDir]);
    const runTool = tools[0];
    const result = await runTool.execute(
      { workflow: "nonexistent", args: "{}" },
      { userId: "alice", sessionId: "s1" },
    );
    expect(result).toContain("Error");
  });
});
