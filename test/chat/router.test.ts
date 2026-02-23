import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { ChatProvider, ChatEvent } from "../../src/chat/types.js";
import { chatRouter } from "../../src/chat/router.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { EventLog } from "../../src/core/event-bus.js";
import { MemoryManager } from "../../src/memory/manager.js";
import { createTestDb } from "../helpers.js";
import "../../src/chat/auth.js";

function mockProvider(events: ChatEvent[]): ChatProvider {
  return {
    name: "test",
    async *stream() {
      for (const e of events) yield e;
    },
  };
}

function setup(events: ChatEvent[]) {
  const db = createTestDb();
  const app = new Hono();
  const provider = mockProvider(events);
  const sessionManager = new SessionManager(db);
  const eventLog = new EventLog(db);

  chatRouter(app, provider, { sessionManager, eventLog, skillsDirs: ["/tmp/test-skills"] });
  return { app, sessionManager, eventLog };
}

describe("chatRouter", () => {
  it("POST /api/chat returns SSE stream", async () => {
    const { app } = setup([
      { type: "text", content: "Hello" },
      { type: "text", content: " world" },
      { type: "done", sessionId: "provider-s1", costUsd: 0.01 },
    ]);

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain(`{"type":"text","content":"Hello"}`);
    expect(text).toContain(`{"type":"text","content":" world"}`);
    expect(text).toContain(`"type":"done"`);
  });

  it("returns 400 if message is missing", async () => {
    const { app } = setup([]);

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("creates a session and persists messages", async () => {
    const { app, sessionManager } = setup([
      { type: "text", content: "Hi there" },
      { type: "done", sessionId: "", costUsd: 0 },
    ]);

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    const text = await res.text();

    // Extract our session ID from done event
    const doneMatch = text.match(/"sessionId":"([^"]+)"/);
    expect(doneMatch).toBeTruthy();
    const sessionId = doneMatch![1];

    // Session should exist in DB
    const session = sessionManager.getById(sessionId);
    expect(session).toBeTruthy();
    expect(session!.channel).toBe("web");
    expect(session!.provider).toBe("test");

    // Messages should be persisted
    const messages = sessionManager.getMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hi there");
  });

  it("resumes an existing session", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);

    // Create a session first
    const session = sessionManager.create({
      userId: "web-anonymous",
      channel: "web",
      channelId: "",
      provider: "test",
    });
    sessionManager.appendMessage(session.id, { role: "user", content: "first msg" });
    sessionManager.appendMessage(session.id, { role: "assistant", content: "first reply" });

    // Track what history the provider receives
    let receivedHistory: unknown[] = [];
    const provider: ChatProvider = {
      name: "test",
      async *stream(req) {
        receivedHistory = req.history ?? [];
        yield { type: "text", content: "second reply" };
        yield { type: "done", sessionId: "", costUsd: 0 };
      },
    };

    const app = new Hono();
    chatRouter(app, provider, { sessionManager, eventLog, skillsDirs: ["/tmp/test-skills"] });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "second msg", sessionId: session.id }),
    });
    await res.text(); // consume stream to ensure done handler runs

    // Provider should receive full history (first msg + first reply + second msg)
    expect(receivedHistory).toHaveLength(3);
    expect(receivedHistory[0]).toMatchObject({ role: "user", content: "first msg" });
    expect(receivedHistory[1]).toMatchObject({ role: "assistant", content: "first reply" });
    expect(receivedHistory[2]).toMatchObject({ role: "user", content: "second msg" });

    // All 4 messages should be in DB
    const messages = sessionManager.getMessages(session.id);
    expect(messages).toHaveLength(4);
  });

  it("stores providerSessionId from done event", async () => {
    const { app, sessionManager } = setup([
      { type: "text", content: "ok" },
      { type: "done", sessionId: "claude-sdk-session-123", costUsd: 0.5 },
    ]);

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    const text = await res.text();
    const doneMatch = text.match(/"sessionId":"([^"]+)"/);
    const sessionId = doneMatch![1];

    // Our session should have the provider's session ID stored
    const session = sessionManager.getById(sessionId);
    expect(session!.providerSessionId).toBe("claude-sdk-session-123");
  });

  it("injects relevant memories into history", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);
    const memoryManager = new MemoryManager(db);

    // Pre-populate memory for the anonymous user
    memoryManager.save("web-anonymous", [
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

    const app = new Hono();
    chatRouter(app, provider, {
      sessionManager,
      eventLog,
      memoryManager,
      skillsDirs: ["/tmp/test-skills"],
    });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "我的 语言 偏好是什么" }),
    });
    await res.text();

    // First message in history should be memory context
    const memoryMsg = receivedHistory.find(
      (m) => m.role === "system" && m.content.includes("语言"),
    );
    expect(memoryMsg).toBeTruthy();
  });

  it("uses userId from Hono context for session creation", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const eventLog = new EventLog(db);

    const provider = mockProvider([
      { type: "text", content: "hi" },
      { type: "done", sessionId: "", costUsd: 0 },
    ]);

    const app = new Hono();

    // Simulate auth middleware setting userId
    app.use("/api/chat", async (c, next) => {
      c.set("userId", "alice");
      return next();
    });

    chatRouter(app, provider, { sessionManager, eventLog, skillsDirs: ["/tmp/test-skills"] });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    const text = await res.text();
    const doneMatch = text.match(/"sessionId":"([^"]+)"/);
    const sid = doneMatch![1];

    const session = sessionManager.getById(sid);
    expect(session!.userId).toBe("alice");
  });
});
