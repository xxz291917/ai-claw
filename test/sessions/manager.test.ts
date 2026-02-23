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

  describe("compactMessages", () => {
    it("deletes early messages and inserts summary, keeps recent intact", () => {
      const db = createTestDb();
      const mgr = new SessionManager(db);
      const session = mgr.create({
        userId: "u1",
        channel: "web_chat",
        channelId: "tab-1",
        provider: "claude",
      });

      // Insert 10 messages
      for (let i = 0; i < 10; i++) {
        mgr.appendMessage(session.id, {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `msg-${i}`,
        });
      }

      const before = mgr.getMessages(session.id);
      expect(before).toHaveLength(10);
      const keptIds = before.slice(7).map((m) => m.id); // last 3
      const keptTimestamps = before.slice(7).map((m) => m.createdAt);

      // Compact: keep 3 recent, replace first 7 with summary
      mgr.compactMessages(session.id, 3, {
        role: "system",
        content: "Summary of early messages",
        type: "summary",
      });

      const after = mgr.getMessages(session.id);
      expect(after).toHaveLength(4); // 1 summary + 3 kept

      // Summary should be first (lowest id)
      expect(after[0].role).toBe("system");
      expect(after[0].content).toBe("Summary of early messages");
      expect(after[0].type).toBe("summary");
      // Summary reuses the last deleted message's id (adjacent to kept messages)
      expect(after[0].id).toBe(before[6].id);
      // Summary preserves the last deleted message's timestamp
      expect(after[0].createdAt).toBe(before[6].createdAt);

      // Recent messages should keep their original IDs and timestamps
      expect(after[1].id).toBe(keptIds[0]);
      expect(after[2].id).toBe(keptIds[1]);
      expect(after[3].id).toBe(keptIds[2]);
      expect(after[1].createdAt).toBe(keptTimestamps[0]);
      expect(after[1].content).toBe("msg-7");
      expect(after[3].content).toBe("msg-9");
    });

    it("does nothing when keepCount >= total messages", () => {
      const db = createTestDb();
      const mgr = new SessionManager(db);
      const session = mgr.create({
        userId: "u1",
        channel: "web_chat",
        channelId: "tab-1",
        provider: "claude",
      });

      mgr.appendMessage(session.id, { role: "user", content: "hello" });
      mgr.appendMessage(session.id, { role: "assistant", content: "hi" });

      mgr.compactMessages(session.id, 5, {
        role: "system",
        content: "should not appear",
      });

      const msgs = mgr.getMessages(session.id);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].content).toBe("hello");
    });
  });

});
