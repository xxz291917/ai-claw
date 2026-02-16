import { describe, it, expect } from "vitest";
import { handleCommand } from "../../src/chat/commands.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { createTestDb } from "../helpers.js";

function setup() {
  const db = createTestDb();
  const sessionManager = new SessionManager(db);
  const session = sessionManager.create({
    userId: "user-1",
    channel: "web",
    channelId: "",
    provider: "test",
  });
  sessionManager.appendMessage(session.id, { role: "user", content: "hello" });
  sessionManager.appendMessage(session.id, {
    role: "assistant",
    content: "hi",
  });
  return { sessionManager, session };
}

describe("handleCommand", () => {
  it("returns null for non-command messages", () => {
    const { sessionManager, session } = setup();
    const result = handleCommand("hello", {
      session,
      sessionManager,
      providerName: "test",
    });
    expect(result).toBeNull();
  });

  it("returns null for unknown commands", () => {
    const { sessionManager, session } = setup();
    const result = handleCommand("/unknown", {
      session,
      sessionManager,
      providerName: "test",
    });
    expect(result).toBeNull();
  });

  it("/new closes current session and creates a new one", () => {
    const { sessionManager, session } = setup();
    const result = handleCommand("/new", {
      session,
      sessionManager,
      providerName: "test",
    });

    expect(result).toBeTruthy();
    expect(result!.newSession).toBeTruthy();
    expect(result!.newSession!.id).not.toBe(session.id);
    expect(result!.events[0]).toMatchObject({
      type: "text",
      content: "New session started.",
    });

    // Old session should be closed
    const old = sessionManager.getById(session.id);
    expect(old!.status).toBe("closed");
  });

  it("/reset clears messages", () => {
    const { sessionManager, session } = setup();
    expect(sessionManager.countMessages(session.id)).toBe(2);

    const result = handleCommand("/reset", {
      session,
      sessionManager,
      providerName: "test",
    });

    expect(result).toBeTruthy();
    expect(result!.events[0].type).toBe("text");
    expect((result!.events[0] as any).content).toContain("2 messages cleared");
    expect(sessionManager.countMessages(session.id)).toBe(0);
  });

  it("/status returns session info", () => {
    const { sessionManager, session } = setup();
    const result = handleCommand("/status", {
      session,
      sessionManager,
      providerName: "test",
    });

    expect(result).toBeTruthy();
    const text = (result!.events[0] as any).content;
    expect(text).toContain(session.id);
    expect(text).toContain("Provider: test");
    expect(text).toContain("Messages: 2");
  });

  it("commands are case-insensitive", () => {
    const { sessionManager, session } = setup();
    const result = handleCommand("/STATUS", {
      session,
      sessionManager,
      providerName: "test",
    });
    expect(result).toBeTruthy();
  });
});
