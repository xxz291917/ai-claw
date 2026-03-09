import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { CronService } from "../../src/cron/service.js";
import { handleCronCommand } from "../../src/cron/commands.js";
import type Database from "better-sqlite3";

// Minimal mock registry that creates a no-op provider
const mockRegistry = {
  create: () => ({
    name: "mock",
    async *stream() {
      yield { type: "text" as const, content: "ok" };
      yield { type: "done" as const, sessionId: "s1", costUsd: 0 };
    },
  }),
  list: () => ["mock"],
  get: () => undefined,
} as any;

// Minimal mock session manager
function createMockSessionManager(db: Database.Database) {
  return {
    create: (opts: any) => ({
      id: "ses-1",
      userId: opts.userId,
      channel: opts.channel,
      channelId: opts.channelId,
      provider: opts.provider,
      status: "active",
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    }),
    getById: () => null,
    appendMessage: () => {},
    getMessages: () => [],
    countMessages: () => 0,
    clearMessages: () => {},
    compactMessages: () => {},
    updateProviderSessionId: () => {},
    close: () => {},
  } as any;
}

describe("handleCronCommand", () => {
  let db: Database.Database;
  let cronService: CronService;

  beforeEach(() => {
    db = createTestDb();
    cronService = new CronService({
      db,
      registry: mockRegistry,
      sessionManager: createMockSessionManager(db),
      eventLog: { log: () => {} } as any,
      defaultProvider: "mock",
    });
  });

  it("shows help by default", () => {
    const result = handleCronCommand([], "user-1", "ses-1", cronService);
    expect(result.events[0]).toMatchObject({ type: "text" });
    expect((result.events[0] as any).content).toContain("Cron commands");
  });

  it("lists empty jobs", () => {
    const result = handleCronCommand(["list"], "user-1", "ses-1", cronService);
    expect((result.events[0] as any).content).toContain("No cron jobs");
  });

  it("adds a job with every schedule", () => {
    const result = handleCronCommand(
      ["add", "test-job", "every", "60000", "say", "hello"],
      "user-1", "ses-1", cronService,
    );
    const content = (result.events[0] as any).content;
    expect(content).toContain("Created cron job");
    expect(content).toContain("test-job");

    // Verify it shows up in list
    const listResult = handleCronCommand(["list"], "user-1", "ses-1", cronService);
    expect((listResult.events[0] as any).content).toContain("test-job");
  });

  it("adds a job with cron schedule", () => {
    const result = handleCronCommand(
      ["add", "daily", "cron", "0 9 * * *", "generate", "report"],
      "user-1", "ses-1", cronService,
    );
    expect((result.events[0] as any).content).toContain("Created cron job");
  });

  it("adds a job with at schedule", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = handleCronCommand(
      ["add", "reminder", "at", future, "remind", "me"],
      "user-1", "ses-1", cronService,
    );
    expect((result.events[0] as any).content).toContain("Created cron job");
  });

  it("shows error for missing prompt", () => {
    const result = handleCronCommand(
      ["add", "test", "every", "60000"],
      "user-1", "ses-1", cronService,
    );
    expect((result.events[0] as any).content).toContain("Missing prompt");
  });

  it("removes a job by id prefix", () => {
    cronService.add({
      name: "to-remove",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agent-turn", prompt: "test" },
      userId: "user-1",
    });
    const jobs = cronService.listByUser("user-1");
    const prefix = jobs[0].id.slice(0, 8);

    const result = handleCronCommand(["remove", prefix], "user-1", "ses-1", cronService);
    expect((result.events[0] as any).content).toContain("Removed job");
    expect(cronService.listByUser("user-1")).toHaveLength(0);
  });

  it("enables and disables a job", () => {
    const job = cronService.add({
      name: "toggle-me",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agent-turn", prompt: "test" },
      userId: "user-1",
    });
    const prefix = job.id.slice(0, 8);

    handleCronCommand(["disable", prefix], "user-1", "ses-1", cronService);
    expect(cronService.getById(job.id)!.enabled).toBe(false);

    handleCronCommand(["enable", prefix], "user-1", "ses-1", cronService);
    expect(cronService.getById(job.id)!.enabled).toBe(true);
  });
});
