import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { ChatProvider, ChatEvent } from "../../src/chat/types.js";
import { larkRouter, type LarkRouterDeps } from "../../src/lark/router.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { EventLog } from "../../src/core/event-bus.js";
import { createTestDb } from "../helpers.js";

function mockProvider(events: ChatEvent[]): ChatProvider {
  return {
    name: "test",
    async *stream() {
      for (const e of events) yield e;
    },
  };
}

function setup(events: ChatEvent[], extraDeps?: Partial<LarkRouterDeps>) {
  const db = createTestDb();
  const app = new Hono();
  const provider = mockProvider(events);
  const sessionManager = new SessionManager(db);
  const eventLog = new EventLog(db);
  const sendCard = vi.fn<(chatId: string, markdown: string) => Promise<string>>().mockResolvedValue("card_msg_id_1");
  const patchCard = vi.fn<(messageId: string, markdown: string) => Promise<void>>().mockResolvedValue(undefined);

  const deps: LarkRouterDeps = {
    provider,
    sessionManager,
    eventLog,
    sendCard,
    patchCard,
    ...extraDeps,
  };

  larkRouter(app, deps);
  return { app, sessionManager, eventLog, sendCard, patchCard };
}

/** Wait for async fire-and-forget processing to complete. */
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe("larkRouter", () => {
  it("handles URL verification challenge", async () => {
    const { app } = setup([]);

    const res = await app.request("/api/lark/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "url_verification",
        token: "test-token",
        challenge: "abc123",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ challenge: "abc123" });
  });

  it("processes a text message and replies", async () => {
    const { app, sendCard, patchCard } = setup([
      { type: "text", content: "Hello from AI" },
      { type: "done", sessionId: "provider-s1", costUsd: 0.01 },
    ]);

    const res = await app.request("/api/lark/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: {
          event_id: "evt_001",
          event_type: "im.message.receive_v1",
          token: "test-token",
        },
        event: {
          sender: {
            sender_id: { open_id: "ou_user1" },
            sender_type: "user",
          },
          message: {
            message_id: "om_msg1",
            chat_id: "oc_chat1",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "hello" }),
          },
        },
      }),
    });

    // Webhook should respond immediately
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ code: 0 });

    // Wait for async processing
    await tick();

    // Should send thinking card first
    expect(sendCard).toHaveBeenCalledWith("oc_chat1", expect.stringContaining("..."));

    // Should patch with final reply
    expect(patchCard).toHaveBeenCalledWith("card_msg_id_1", "Hello from AI");
  });

  it("creates a session with lark channel", async () => {
    const { app, sessionManager, sendCard } = setup([
      { type: "text", content: "ok" },
      { type: "done", sessionId: "", costUsd: 0 },
    ]);

    await app.request("/api/lark/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: {
          event_id: "evt_002",
          event_type: "im.message.receive_v1",
          token: "test-token",
        },
        event: {
          sender: {
            sender_id: { open_id: "ou_user2" },
            sender_type: "user",
          },
          message: {
            message_id: "om_msg2",
            chat_id: "oc_chat2",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "hi" }),
          },
        },
      }),
    });

    await tick();

    // sendCard should have been called (meaning processing happened)
    expect(sendCard).toHaveBeenCalled();

    // Find the session created for this lark user
    const session = sessionManager.findActive("lark:ou_user2", "lark");
    expect(session).toBeTruthy();
    expect(session!.channel).toBe("lark");
    expect(session!.channelId).toBe("oc_chat2");
    expect(session!.userId).toBe("lark:ou_user2");
  });

  it("ignores non-text messages", async () => {
    const { app, sendCard } = setup([
      { type: "text", content: "should not happen" },
      { type: "done", sessionId: "", costUsd: 0 },
    ]);

    const res = await app.request("/api/lark/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "2.0",
        header: {
          event_id: "evt_003",
          event_type: "im.message.receive_v1",
          token: "test-token",
        },
        event: {
          sender: {
            sender_id: { open_id: "ou_user3" },
            sender_type: "user",
          },
          message: {
            message_id: "om_msg3",
            chat_id: "oc_chat3",
            chat_type: "p2p",
            message_type: "image",
            content: "{}",
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    await tick();

    // No card should be sent for non-text messages
    expect(sendCard).not.toHaveBeenCalled();
  });

  it("deduplicates events by message_id", async () => {
    const { app, sendCard } = setup([
      { type: "text", content: "reply" },
      { type: "done", sessionId: "", costUsd: 0 },
    ]);

    const eventBody = {
      schema: "2.0",
      header: {
        event_id: "evt_004",
        event_type: "im.message.receive_v1",
        token: "test-token",
      },
      event: {
        sender: {
          sender_id: { open_id: "ou_user4" },
          sender_type: "user",
        },
        message: {
          message_id: "om_msg_dup",
          chat_id: "oc_chat4",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "dup test" }),
        },
      },
    };

    // Send the same event twice
    await app.request("/api/lark/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventBody),
    });

    await app.request("/api/lark/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventBody),
    });

    await tick();

    // sendCard should only be called once despite two identical events
    expect(sendCard).toHaveBeenCalledTimes(1);
  });
});
