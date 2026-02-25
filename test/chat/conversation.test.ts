import { describe, it, expect } from "vitest";
import type { ChatProvider, ChatEvent } from "../../src/chat/types.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { EventLog } from "../../src/core/event-bus.js";
import { MemoryManager } from "../../src/memory/manager.js";
import { createTestDb } from "../helpers.js";
import {
  handleConversation,
  type ConversationDeps,
  type ConversationRequest,
} from "../../src/chat/conversation.js";

function mockProvider(events: ChatEvent[]): ChatProvider {
  return {
    name: "test",
    async *stream() {
      for (const e of events) yield e;
    },
  };
}

function makeDeps(
  events: ChatEvent[],
  opts?: { memoryManager?: MemoryManager },
): { deps: ConversationDeps; sessionManager: SessionManager; eventLog: EventLog } {
  const db = createTestDb();
  const sessionManager = new SessionManager(db);
  const eventLog = new EventLog(db);
  const memoryManager = opts?.memoryManager ?? undefined;
  const provider = mockProvider(events);

  return {
    deps: { provider, sessionManager, eventLog, memoryManager },
    sessionManager,
    eventLog,
  };
}

describe("handleConversation", () => {
  it("creates a session and returns assistant reply", async () => {
    const { deps, sessionManager } = makeDeps([
      { type: "text", content: "Hello" },
      { type: "text", content: " world" },
      { type: "done", sessionId: "provider-s1", costUsd: 0.01 },
    ]);

    const result = await handleConversation({
      userId: "user-1",
      message: "hi",
      channel: "test",
      channelId: "ch-1",
      deps,
    });

    // Text should be collected from all text events
    expect(result.text).toBe("Hello world");
    expect(result.costUsd).toBe(0.01);
    expect(result.sessionId).toBeTruthy();
    expect(result.error).toBeUndefined();

    // Events should include all provider events
    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({ type: "text", content: "Hello" });
    expect(result.events[1]).toMatchObject({ type: "text", content: " world" });
    expect(result.events[2]).toMatchObject({ type: "done" });

    // Session should exist in DB
    const session = sessionManager.getById(result.sessionId);
    expect(session).toBeTruthy();
    expect(session!.channel).toBe("test");
    expect(session!.userId).toBe("user-1");
    expect(session!.provider).toBe("test");

    // Messages should be persisted (user + assistant)
    const messages = sessionManager.getMessages(result.sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hi");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hello world");
  });

  it("reuses an existing session", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);

    // Create a session first with some history
    const session = sessionManager.create({
      userId: "user-1",
      channel: "test",
      channelId: "ch-1",
      provider: "test",
    });
    sessionManager.appendMessage(session.id, { role: "user", content: "first msg" });
    sessionManager.appendMessage(session.id, { role: "assistant", content: "first reply" });

    // Track what history the provider receives
    let receivedHistory: Array<{ role: string; content: string }> = [];
    const provider: ChatProvider = {
      name: "test",
      async *stream(req) {
        receivedHistory = req.history ?? [];
        yield { type: "text", content: "second reply" };
        yield { type: "done", sessionId: "", costUsd: 0 };
      },
    };

    const result = await handleConversation({
      userId: "user-1",
      message: "second msg",
      sessionId: session.id,
      channel: "test",
      channelId: "ch-1",
      deps: { provider, sessionManager, eventLog },
    });

    expect(result.sessionId).toBe(session.id);
    expect(result.text).toBe("second reply");

    // Provider should receive: identity system msg + first msg + first reply + second msg
    expect(receivedHistory).toHaveLength(4);
    expect(receivedHistory[0]).toMatchObject({ role: "system" });
    expect((receivedHistory[0] as any).content).toContain("user-1");
    expect(receivedHistory[1]).toMatchObject({ role: "user", content: "first msg" });
    expect(receivedHistory[2]).toMatchObject({ role: "assistant", content: "first reply" });
    expect(receivedHistory[3]).toMatchObject({ role: "user", content: "second msg" });

    // All 4 messages should be in DB (first msg + first reply + second msg + second reply)
    const messages = sessionManager.getMessages(session.id);
    expect(messages).toHaveLength(4);
  });

  it("injects memories into history", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);
    const memoryManager = new MemoryManager(db);

    // Pre-populate memory
    memoryManager.save("user-1", [
      { category: "preference", key: "语言", value: "中文" },
    ]);

    let receivedHistory: Array<{ role: string; content: string }> = [];
    const provider: ChatProvider = {
      name: "test",
      async *stream(req) {
        receivedHistory = req.history ?? [];
        yield { type: "text", content: "ok" };
        yield { type: "done", sessionId: "", costUsd: 0 };
      },
    };

    const result = await handleConversation({
      userId: "user-1",
      message: "我的 语言 偏好是什么",
      channel: "test",
      channelId: "ch-1",
      deps: { provider, sessionManager, eventLog, memoryManager },
    });

    expect(result.text).toBe("ok");

    // First message in history should contain memory context
    const memoryMsg = receivedHistory.find(
      (m) => m.role === "system" && m.content.includes("语言"),
    );
    expect(memoryMsg).toBeTruthy();
    expect(memoryMsg!.content).toContain("中文");
  });

  it("handles provider errors gracefully", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);

    const provider: ChatProvider = {
      name: "test",
      async *stream() {
        yield { type: "text" as const, content: "partial " };
        yield { type: "text" as const, content: "response" };
        throw new Error("connection lost");
      },
    };

    const result = await handleConversation({
      userId: "user-1",
      message: "hello",
      channel: "test",
      channelId: "ch-1",
      deps: { provider, sessionManager, eventLog },
    });

    // Should capture partial text
    expect(result.text).toBe("partial response");

    // Should have error field
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("connection lost");

    // Events should include the text events collected before the error
    expect(result.events.length).toBeGreaterThanOrEqual(2);
    expect(result.events[0]).toMatchObject({ type: "text", content: "partial " });
    expect(result.events[1]).toMatchObject({ type: "text", content: "response" });

    // Partial response should be saved to DB
    const messages = sessionManager.getMessages(result.sessionId);
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeTruthy();
    expect(assistantMsg!.content).toBe("partial response");
  });

  it("stores providerSessionId from done event", async () => {
    const { deps, sessionManager } = makeDeps([
      { type: "text", content: "ok" },
      { type: "done", sessionId: "claude-sdk-session-123", costUsd: 0.5 },
    ]);

    const result = await handleConversation({
      userId: "user-1",
      message: "hi",
      channel: "test",
      channelId: "ch-1",
      deps,
    });

    const session = sessionManager.getById(result.sessionId);
    expect(session!.providerSessionId).toBe("claude-sdk-session-123");
  });

  it("skips history injection for native context providers", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);

    // Create session with existing history
    const session = sessionManager.create({
      userId: "user-1",
      channel: "test",
      channelId: "ch-1",
      provider: "test",
    });
    sessionManager.appendMessage(session.id, { role: "user", content: "old msg" });
    sessionManager.appendMessage(session.id, { role: "assistant", content: "old reply" });

    let receivedRequest: { history?: unknown; systemPromptAddition?: string } = {};
    const provider: ChatProvider = {
      name: "test",
      usesNativeContext: true,
      async *stream(req) {
        receivedRequest = { history: req.history, systemPromptAddition: req.systemPromptAddition };
        yield { type: "text", content: "ok" };
        yield { type: "done", sessionId: "", costUsd: 0 };
      },
    };

    await handleConversation({
      userId: "user-1",
      message: "new msg",
      sessionId: session.id,
      channel: "test",
      channelId: "ch-1",
      deps: { provider, sessionManager, eventLog },
    });

    // Native context providers should NOT receive history
    expect(receivedRequest.history).toBeUndefined();

    // Should receive user identity in systemPromptAddition
    expect(receivedRequest.systemPromptAddition).toContain("user-1");
  });

  it("passes memories via systemPromptAddition for native context providers", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);
    const memoryManager = new MemoryManager(db);

    memoryManager.save("user-1", [
      { category: "preference", key: "语言", value: "中文" },
    ]);

    let receivedAddition = "";
    const provider: ChatProvider = {
      name: "test",
      usesNativeContext: true,
      async *stream(req) {
        receivedAddition = req.systemPromptAddition ?? "";
        yield { type: "text", content: "ok" };
        yield { type: "done", sessionId: "", costUsd: 0 };
      },
    };

    await handleConversation({
      userId: "user-1",
      message: "我的 语言 偏好是什么",
      channel: "test",
      channelId: "ch-1",
      deps: { provider, sessionManager, eventLog, memoryManager },
    });

    // Memory should be in systemPromptAddition, not history
    expect(receivedAddition).toContain("语言");
    expect(receivedAddition).toContain("中文");
  });

  it("enforces per-session concurrency", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);

    // Create a session
    const session = sessionManager.create({
      userId: "user-1",
      channel: "test",
      channelId: "ch-1",
      provider: "test",
    });

    const order: string[] = [];
    let resolveFirst: () => void;
    const firstBlocked = new Promise<void>((r) => (resolveFirst = r));

    const slowProvider: ChatProvider = {
      name: "test",
      async *stream(req) {
        const msg = req.message;
        if (msg.includes("first")) {
          order.push("first-start");
          // Wait until we know the second request has been initiated
          await firstBlocked;
          order.push("first-end");
        } else {
          order.push("second-start");
          order.push("second-end");
        }
        yield { type: "text", content: `reply to ${msg}` };
        yield { type: "done", sessionId: "", costUsd: 0 };
      },
    };

    const deps: ConversationDeps = { provider: slowProvider, sessionManager, eventLog };

    // Start both requests concurrently on same session
    const p1 = handleConversation({
      userId: "user-1",
      message: "first",
      sessionId: session.id,
      channel: "test",
      channelId: "ch-1",
      deps,
    });

    // Give first request a moment to start, then release it
    await new Promise((r) => setTimeout(r, 10));
    const p2 = handleConversation({
      userId: "user-1",
      message: "second",
      sessionId: session.id,
      channel: "test",
      channelId: "ch-1",
      deps,
    });

    // Unblock the first request
    resolveFirst!();

    await Promise.all([p1, p2]);

    // Second should only start after first finishes
    expect(order.indexOf("first-end")).toBeLessThan(order.indexOf("second-start"));
  });
});
