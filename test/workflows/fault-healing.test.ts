import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { TaskStore } from "../../src/tasks/store.js";
import { FaultHealingWorkflow } from "../../src/workflows/fault-healing.js";
import type Database from "better-sqlite3";

describe("FaultHealingWorkflow", () => {
  let db: Database.Database;
  let store: TaskStore;
  let workflow: FaultHealingWorkflow;

  const mockRunAgent = vi.fn();
  const mockSendCard = vi.fn().mockResolvedValue("msg-123");

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    workflow = new FaultHealingWorkflow({
      store,
      runAgent: mockRunAgent,
      sendLarkCard: mockSendCard,
    });
    mockRunAgent.mockReset();
    mockSendCard.mockReset().mockResolvedValue("msg-123");
  });

  it("runs analysis phase: pending → analyzing → reported", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-1",
      sentryEventId: "evt-1",
      title: "TypeError",
      severity: "P1",
    });

    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        rootCause: "Null ref",
        confidence: "92%",
        impact: "1.2k users",
        affectedFiles: ["handler.ts"],
      }),
      sessionId: "sess-1",
      costUsd: 0.05,
    });

    await workflow.runAnalysis(task.id);

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("reported");
    expect(updated?.analysis).toContain("Null ref");
    expect(mockSendCard).toHaveBeenCalledOnce();
  });

  it("handles analysis failure gracefully", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-2",
      sentryEventId: "evt-2",
      title: "Error",
      severity: "P1",
    });

    mockRunAgent.mockResolvedValueOnce({
      text: "",
      sessionId: "sess-2",
      costUsd: 0.03,
      error: "Context overflow",
    });

    await workflow.runAnalysis(task.id);

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("failed");
    expect(updated?.error).toContain("Context overflow");
  });

  it("runs fix phase: reported → fixing → pr_ready", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-3",
      sentryEventId: "evt-3",
      title: "TypeError",
      severity: "P1",
    });
    store.transition(task.id, "analyze");
    store.transition(task.id, "report");

    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        filesChanged: 2,
        linesAdded: 8,
        testsPassed: 15,
        testsFailed: 0,
      }),
      sessionId: "sess-3",
      costUsd: 0.12,
    });

    await workflow.runFix(task.id);

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("pr_ready");
    expect(updated?.prUrl).toContain("/pull/42");
    expect(mockSendCard).toHaveBeenCalledOnce();
  });

  it("handles fix failure from AI", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-4",
      sentryEventId: "evt-4",
      title: "TypeError",
      severity: "P1",
    });
    store.transition(task.id, "analyze");
    store.transition(task.id, "report");

    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({ error: "Tests failed after fix" }),
      sessionId: "sess-4",
      costUsd: 0.08,
    });

    await workflow.runFix(task.id);

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("failed");
    expect(updated?.error).toContain("Tests failed");
  });

  it("handles Lark callback actions", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-5",
      sentryEventId: "evt-5",
      title: "Error",
      severity: "P2",
    });
    store.transition(task.id, "analyze");
    store.transition(task.id, "report");

    await workflow.handleAction(task.id, "ignore");

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("ignored");
  });
});
