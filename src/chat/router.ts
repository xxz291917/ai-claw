import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatProvider } from "./types.js";

export function chatRouter(app: Hono, provider: ChatProvider): void {
  app.post("/api/chat", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = body.message;
    const sessionId = body.sessionId;

    if (!message || typeof message !== "string") {
      return c.json({ error: "message is required" }, 400);
    }

    return streamSSE(c, async (stream) => {
      for await (const event of provider.stream({ message, sessionId })) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    });
  });
}
