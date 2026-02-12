import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { TaskStore } from "../../src/tasks/store.js";
import type Database from "better-sqlite3";

describe("TaskStore", () => {
  let db: Database.Database;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  it("creates a task with pending state", () => {
    const task = store.create({
      sentryIssueId: "ISSUE-1",
      sentryEventId: "evt-abc",
      title: "TypeError in handler.ts",
      severity: "P1",
    });

    expect(task.id).toBeDefined();
    expect(task.state).toBe("pending");
    expect(task.sentryIssueId).toBe("ISSUE-1");
  });

  it("deduplicates by sentry_issue_id", () => {
    store.create({
      sentryIssueId: "ISSUE-1",
      sentryEventId: "evt-1",
      title: "Error",
      severity: "P1",
    });
    const dup = store.findByIssueId("ISSUE-1");
    expect(dup).not.toBeNull();
  });

  it("transitions state: pending → analyzing", () => {
    const task = store.create({
      sentryIssueId: "ISSUE-2",
      sentryEventId: "evt-2",
      title: "Error",
      severity: "P2",
    });
    const updated = store.transition(task.id, "analyze");
    expect(updated.state).toBe("analyzing");
  });

  it("rejects invalid transition: pending → fixing", () => {
    const task = store.create({
      sentryIssueId: "ISSUE-3",
      sentryEventId: "evt-3",
      title: "Error",
      severity: "P3",
    });
    expect(() => store.transition(task.id, "fix")).toThrow(
      /invalid transition/i,
    );
  });

  it("stores analysis result", () => {
    const task = store.create({
      sentryIssueId: "ISSUE-4",
      sentryEventId: "evt-4",
      title: "Error",
      severity: "P1",
    });
    store.transition(task.id, "analyze");
    store.updateAnalysis(task.id, "Root cause: null ref in handler.ts:42");
    const found = store.getById(task.id);
    expect(found?.analysis).toContain("null ref");
  });

  it("stores PR URL after full transition", () => {
    const task = store.create({
      sentryIssueId: "ISSUE-5",
      sentryEventId: "evt-5",
      title: "Error",
      severity: "P1",
    });
    store.transition(task.id, "analyze");
    store.transition(task.id, "report");
    store.transition(task.id, "fix");
    store.updatePrUrl(task.id, "https://github.com/org/repo/pull/42");
    const found = store.getById(task.id);
    expect(found?.prUrl).toContain("/pull/42");
  });
});
