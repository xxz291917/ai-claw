import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { CronStore } from "../../src/cron/store.js";
import type { CronJobInput } from "../../src/cron/types.js";
import type Database from "better-sqlite3";

function makeInput(overrides?: Partial<CronJobInput>): CronJobInput {
  return {
    name: "test-job",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "agent-turn", prompt: "hello" },
    userId: "user-1",
    ...overrides,
  };
}

describe("CronStore", () => {
  let db: Database.Database;
  let store: CronStore;

  beforeEach(() => {
    db = createTestDb();
    store = new CronStore(db);
  });

  it("adds and retrieves a job", () => {
    const job = store.add(makeInput());
    expect(job.id).toBeTruthy();
    expect(job.name).toBe("test-job");
    expect(job.enabled).toBe(true);
    expect(job.userId).toBe("user-1");
    expect(job.nextRunAt).not.toBeNull();
    expect(job.consecutiveErrors).toBe(0);

    const found = store.getById(job.id);
    expect(found).toEqual(job);
  });

  it("lists all jobs", () => {
    store.add(makeInput({ name: "a" }));
    store.add(makeInput({ name: "b" }));
    expect(store.list()).toHaveLength(2);
  });

  it("lists jobs by user", () => {
    store.add(makeInput({ name: "a", userId: "u1" }));
    store.add(makeInput({ name: "b", userId: "u2" }));
    expect(store.listByUser("u1")).toHaveLength(1);
    expect(store.listByUser("u2")).toHaveLength(1);
    expect(store.listByUser("u3")).toHaveLength(0);
  });

  it("updates a job", () => {
    const job = store.add(makeInput());
    const updated = store.update(job.id, { name: "renamed", enabled: false });
    expect(updated!.name).toBe("renamed");
    expect(updated!.enabled).toBe(false);
  });

  it("returns null when updating non-existent job", () => {
    expect(store.update("nonexistent", { name: "x" })).toBeNull();
  });

  it("removes a job", () => {
    const job = store.add(makeInput());
    expect(store.remove(job.id)).toBe(true);
    expect(store.getById(job.id)).toBeNull();
    expect(store.remove(job.id)).toBe(false);
  });

  it("lists due jobs", () => {
    const j1 = store.add(makeInput({ name: "soon" }));
    store.add(makeInput({ name: "disabled", enabled: false }));

    // j1 has nextRunAt = now + 60_000
    // Query with a time far in the future
    const due = store.listDue(Date.now() + 120_000);
    expect(due).toHaveLength(1);
    expect(due[0].name).toBe("soon");

    // Query with time in the past — none due
    expect(store.listDue(0)).toHaveLength(0);
  });

  it("marks started and finished", () => {
    const job = store.add(makeInput());
    const now = Date.now();

    store.markStarted(job.id, now);
    let updated = store.getById(job.id)!;
    expect(updated.lastRunAt).toBe(now);
    expect(updated.nextRunAt).toBeNull(); // cleared to prevent double-fire

    store.markFinished(job.id, "ok");
    updated = store.getById(job.id)!;
    expect(updated.lastStatus).toBe("ok");
    expect(updated.consecutiveErrors).toBe(0);
    expect(updated.nextRunAt).not.toBeNull(); // recomputed
  });

  it("increments consecutive errors on failure", () => {
    const job = store.add(makeInput());

    store.markStarted(job.id, Date.now());
    store.markFinished(job.id, "error", "boom");
    let updated = store.getById(job.id)!;
    expect(updated.lastStatus).toBe("error");
    expect(updated.lastError).toBe("boom");
    expect(updated.consecutiveErrors).toBe(1);

    store.markStarted(job.id, Date.now());
    store.markFinished(job.id, "error", "boom2");
    updated = store.getById(job.id)!;
    expect(updated.consecutiveErrors).toBe(2);

    // Success resets counter
    store.markStarted(job.id, Date.now());
    store.markFinished(job.id, "ok");
    updated = store.getById(job.id)!;
    expect(updated.consecutiveErrors).toBe(0);
  });

  it("computes nextWakeAt", () => {
    expect(store.nextWakeAt()).toBeNull(); // no jobs

    store.add(makeInput());
    const wake = store.nextWakeAt();
    expect(wake).not.toBeNull();
    expect(wake!).toBeGreaterThan(Date.now());
  });

  it("handles at schedule (one-shot)", () => {
    const futureAt = new Date(Date.now() + 3600_000).toISOString();
    const job = store.add(makeInput({
      schedule: { kind: "at", at: futureAt },
    }));
    expect(job.nextRunAt).toBe(new Date(futureAt).getTime());
  });

  it("handles cron expression schedule", () => {
    const job = store.add(makeInput({
      schedule: { kind: "cron", expr: "0 9 * * *" },
    }));
    expect(job.nextRunAt).not.toBeNull();
  });
});
