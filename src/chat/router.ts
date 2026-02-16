import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatProvider } from "./types.js";
import type { SessionManager } from "../sessions/manager.js";
import type { EventBus } from "../core/event-bus.js";
import type { WebChatInputAdapter } from "../adapters/input/web-chat.js";
import { handleCommand } from "./commands.js";
import { compactHistory } from "./compaction.js";

type ChatRouterDeps = {
  sessionManager: SessionManager;
  eventBus: EventBus;
  webChatAdapter: WebChatInputAdapter;
  maxHistoryMessages?: number;
};

// Per-session concurrency lock — same session requests queue, cross-session parallel
const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let unlock: () => void;
  const next = new Promise<void>((r) => (unlock = r));
  sessionLocks.set(sessionId, next);
  return prev.then(() => fn()).finally(() => {
    unlock();
    // Clean up if no more pending work
    if (sessionLocks.get(sessionId) === next) {
      sessionLocks.delete(sessionId);
    }
  });
}

export function chatRouter(
  app: Hono,
  provider: ChatProvider,
  deps: ChatRouterDeps,
): void {
  const { sessionManager, eventBus, webChatAdapter } = deps;
  const maxHistoryMessages = deps.maxHistoryMessages ?? 40;

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

    // 2. Handle slash commands (before LLM call)
    const cmdResult = handleCommand(message, {
      session,
      sessionManager,
      providerName: provider.name,
    });
    if (cmdResult) {
      if (cmdResult.newSession) {
        session = cmdResult.newSession;
      }
      return streamSSE(c, async (stream) => {
        for (const event of cmdResult.events) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
      });
    }

    // 3. Per-session lock — queue concurrent requests for same session
    return withSessionLock(session.id, async () => {
      // 4. Record user message
      sessionManager.appendMessage(session.id, {
        role: "user",
        content: message,
      });

      // 5. Load and compact history
      const rawHistory = sessionManager.getMessages(session.id).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const history = await compactHistory(rawHistory, {
        maxMessages: maxHistoryMessages,
        summarize: provider.summarize?.bind(provider),
      });

      return streamSSE(c, async (stream) => {
        let assistantText = "";

        // 6. Stream from provider
        for await (const event of provider.stream({
          message,
          sessionId: session.providerSessionId ?? undefined,
          history,
        })) {
          if (event.type === "text") {
            assistantText += event.content;
          }

          if (event.type === "done") {
            // 7. Record assistant reply
            if (assistantText) {
              sessionManager.appendMessage(session.id, {
                role: "assistant",
                content: assistantText,
              });
            }

            // 8. Store provider session ID
            if (event.sessionId) {
              sessionManager.updateProviderSessionId(
                session.id,
                event.sessionId,
              );
            }

            // 9. Replace sessionId with ours
            await stream.writeSSE({
              data: JSON.stringify({ ...event, sessionId: session.id }),
            });

            // 10. Emit event for audit log (async, non-blocking)
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
  });
}
