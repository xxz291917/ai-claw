import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { ChatProvider, ChatEvent } from "../../src/chat/types.js";
import { chatRouter } from "../../src/chat/router.js";

function mockProvider(events: ChatEvent[]): ChatProvider {
  return {
    name: "test",
    async *stream() {
      for (const e of events) yield e;
    },
  };
}

describe("chatRouter", () => {
  it("POST /api/chat returns SSE stream", async () => {
    const app = new Hono();
    chatRouter(
      app,
      mockProvider([
        { type: "text", content: "Hello" },
        { type: "text", content: " world" },
        { type: "done", sessionId: "s1", costUsd: 0.01 },
      ]),
    );

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
    const app = new Hono();
    chatRouter(app, mockProvider([]));

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});
