import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatProvider } from "./types.js";
import type { SessionManager } from "../sessions/manager.js";
import type { EventBus } from "../core/event-bus.js";
import type { WebChatInputAdapter } from "../adapters/input/web-chat.js";

type ChatRouterDeps = {
  sessionManager: SessionManager;
  eventBus: EventBus;
  webChatAdapter: WebChatInputAdapter;
};

export function chatRouter(
  app: Hono,
  provider: ChatProvider,
  deps: ChatRouterDeps,
): void {
  const { sessionManager, eventBus, webChatAdapter } = deps;

  app.post("/api/chat", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = body.message;
    const sessionId: string | undefined = body.sessionId;

    if (!message || typeof message !== "string") {
      return c.json({ error: "message is required" }, 400);
    }

    // 1. Resolve or create session
    let session = sessionId ? sessionManager.getById(sessionId) : null;
    if (!session) {
      session = sessionManager.create({
        userId: "web-anonymous",
        channel: "web",
        channelId: "",
        provider: provider.name,
      });
    }

    // 2. Record user message
    sessionManager.appendMessage(session.id, { role: "user", content: message });

    // 3. Load history for provider
    const history = sessionManager.getMessages(session.id).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    return streamSSE(c, async (stream) => {
      let assistantText = "";

      // 4. Stream from provider (pass providerSessionId for Claude resume)
      for await (const event of provider.stream({
        message,
        sessionId: session.providerSessionId ?? undefined,
        history,
      })) {
        if (event.type === "text") {
          assistantText += event.content;
        }

        if (event.type === "done") {
          // 5. Record assistant reply
          if (assistantText) {
            sessionManager.appendMessage(session.id, {
              role: "assistant",
              content: assistantText,
            });
          }

          // 6. Store provider session ID (Claude SDK returns its own session_id)
          if (event.sessionId) {
            sessionManager.updateProviderSessionId(session.id, event.sessionId);
          }

          // 7. Replace provider sessionId with our session ID
          await stream.writeSSE({
            data: JSON.stringify({
              ...event,
              sessionId: session.id,
            }),
          });

          // 8. Emit event for audit log (async, non-blocking)
          const hubEvent = webChatAdapter.toEvent({
            message,
            sessionId: session.id,
          });
          if (hubEvent) {
            eventBus.emit(hubEvent).catch(() => {});
          }
        } else {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
      }
    });
  });
}
