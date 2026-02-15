import { describe, it, expect } from "vitest";
import { SessionManager } from "../../src/sessions/manager.js";
import { createTestDb } from "../helpers.js";

describe("SessionManager", () => {
  it("creates a new session", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const session = mgr.create({
      userId: "ou_user1",
      channel: "lark_p2p",
      channelId: "ou_user1",
      provider: "claude",
    });
    expect(session.id).toBeTruthy();
    expect(session.userId).toBe("ou_user1");
    expect(session.status).toBe("active");
  });

  it("finds active session by userId and channel", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const created = mgr.create({
      userId: "ou_user1",
      channel: "lark_p2p",
      channelId: "ou_user1",
      provider: "claude",
    });
    const found = mgr.findActive("ou_user1", "lark_p2p");
    expect(found?.id).toBe(created.id);
  });

  it("returns null when no active session", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const found = mgr.findActive("nonexistent", "lark_p2p");
    expect(found).toBeNull();
  });

  it("appends and retrieves messages", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const session = mgr.create({
      userId: "u1",
      channel: "web_chat",
      channelId: "tab-1",
      provider: "deepseek",
    });
    mgr.appendMessage(session.id, { role: "user", content: "hello" });
    mgr.appendMessage(session.id, { role: "assistant", content: "hi there" });
    const messages = mgr.getMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("updates providerSessionId", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const session = mgr.create({
      userId: "u1",
      channel: "lark_p2p",
      channelId: "u1",
      provider: "claude",
    });
    mgr.updateProviderSessionId(session.id, "claude-session-xyz");
    const updated = mgr.getById(session.id);
    expect(updated?.providerSessionId).toBe("claude-session-xyz");
  });

  it("touches lastActiveAt", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const session = mgr.create({
      userId: "u1",
      channel: "web_chat",
      channelId: "tab-1",
      provider: "claude",
    });
    mgr.touch(session.id);
    const after = mgr.getById(session.id)!;
    expect(after.lastActiveAt).toBeTruthy();
  });

  it("closes a session", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const session = mgr.create({
      userId: "u1",
      channel: "web_chat",
      channelId: "tab-1",
      provider: "claude",
    });
    mgr.close(session.id);
    const closed = mgr.getById(session.id)!;
    expect(closed.status).toBe("closed");
  });

  it("does not find closed sessions via findActive", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const session = mgr.create({
      userId: "u1",
      channel: "web_chat",
      channelId: "tab-1",
      provider: "claude",
    });
    mgr.close(session.id);
    const found = mgr.findActive("u1", "web_chat");
    expect(found).toBeNull();
  });

  it("appendMessage touches session lastActiveAt", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const session = mgr.create({
      userId: "u1",
      channel: "web_chat",
      channelId: "tab-1",
      provider: "claude",
    });
    const before = mgr.getById(session.id)!;
    mgr.appendMessage(session.id, { role: "user", content: "test" });
    const after = mgr.getById(session.id)!;
    expect(after.lastActiveAt).toBeTruthy();
    // lastActiveAt should be >= before (same or later)
    expect(after.lastActiveAt >= before.lastActiveAt).toBe(true);
  });

  it("stores toolCalls in messages", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);
    const session = mgr.create({
      userId: "u1",
      channel: "web_chat",
      channelId: "tab-1",
      provider: "claude",
    });
    const toolCallsJson = JSON.stringify([{ name: "search", args: { q: "test" } }]);
    const msg = mgr.appendMessage(session.id, {
      role: "assistant",
      content: "Let me search that.",
      toolCalls: toolCallsJson,
    });
    expect(msg.toolCalls).toBe(toolCallsJson);
    const messages = mgr.getMessages(session.id);
    expect(messages[0].toolCalls).toBe(toolCallsJson);
  });
});
