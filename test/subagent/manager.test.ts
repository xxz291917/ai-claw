import { describe, it, expect, vi } from "vitest";
import { SubagentManager } from "../../src/subagent/manager.js";
import { ProviderRegistry } from "../../src/chat/provider-registry.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { createTestDb } from "../helpers.js";
import type { ChatProvider } from "../../src/chat/types.js";

function fakeProvider(reply: string): ChatProvider {
  return {
    name: "test",
    async *stream() {
      yield { type: "text" as const, content: reply };
      yield { type: "done" as const, sessionId: "", costUsd: 0 };
    },
  };
}

describe("SubagentManager", () => {
  it("spawns a task and writes result to parent session", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => fakeProvider("task result here"),
    });

    const parentSession = sessionManager.create({
      userId: "user-1",
      channel: "web",
      channelId: "",
      provider: "test",
    });

    const manager = new SubagentManager({ registry, sessionManager });

    const taskId = manager.spawn({
      task: "research something",
      parentSessionId: parentSession.id,
      userId: "user-1",
      providerName: "test",
    });

    expect(taskId).toBeTruthy();

    // Wait for async completion
    await vi.waitFor(
      () => {
        const task = manager.getTask(taskId);
        expect(task?.status).toBe("completed");
      },
      { timeout: 5000 },
    );

    // Result should be written to parent session
    const messages = sessionManager.getMessages(parentSession.id);
    const systemMsg = messages.find(
      (m) => m.role === "system" && m.content.includes("task result here"),
    );
    expect(systemMsg).toBeTruthy();
  });

  it("lists tasks by session", () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => fakeProvider("ok"),
    });

    const manager = new SubagentManager({ registry, sessionManager });

    manager.spawn({
      task: "task a",
      parentSessionId: "session-1",
      userId: "user-1",
      providerName: "test",
    });
    manager.spawn({
      task: "task b",
      parentSessionId: "session-1",
      userId: "user-1",
      providerName: "test",
    });
    manager.spawn({
      task: "task c",
      parentSessionId: "session-2",
      userId: "user-1",
      providerName: "test",
    });

    expect(manager.listBySession("session-1")).toHaveLength(2);
    expect(manager.listBySession("session-2")).toHaveLength(1);
  });

  it("cancels tasks by session", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();

    // Provider that blocks
    let blocked = true;
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => ({
        name: "test",
        async *stream() {
          while (blocked) await new Promise((r) => setTimeout(r, 50));
          yield { type: "done" as const, sessionId: "", costUsd: 0 };
        },
      }),
    });

    const manager = new SubagentManager({ registry, sessionManager });

    manager.spawn({
      task: "long task",
      parentSessionId: "session-1",
      userId: "user-1",
      providerName: "test",
    });

    const cancelled = manager.cancelBySession("session-1");
    expect(cancelled).toBe(1);

    const tasks = manager.listBySession("session-1");
    expect(tasks[0].status).toBe("cancelled");

    blocked = false; // cleanup
  });

  it("handles provider errors gracefully", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => ({
        name: "test",
        async *stream() {
          throw new Error("provider crashed");
        },
      }),
    });

    const parentSession = sessionManager.create({
      userId: "user-1",
      channel: "web",
      channelId: "",
      provider: "test",
    });

    const manager = new SubagentManager({ registry, sessionManager });

    const taskId = manager.spawn({
      task: "doomed task",
      parentSessionId: parentSession.id,
      userId: "user-1",
      providerName: "test",
    });

    await vi.waitFor(
      () => {
        const task = manager.getTask(taskId);
        expect(task?.status).not.toBe("running");
      },
      { timeout: 5000 },
    );

    const task = manager.getTask(taskId);
    // Task should be completed (handleConversation catches errors) or failed
    expect(["completed", "failed"]).toContain(task?.status);
  });
});
