import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatProvider } from "./types.js";
import type { SessionManager } from "../sessions/manager.js";
import type { EventLog } from "../core/event-bus.js";
import { createHubEvent } from "../core/hub-event.js";
import type { MemoryManager } from "../memory/manager.js";
import type { MemoryFlushFn } from "./compaction.js";
import { handleCommand } from "./commands.js";
import { compactHistory } from "./compaction.js";
import { extractMemories } from "../memory/extractor.js";

type ChatRouterDeps = {
  sessionManager: SessionManager;
  eventLog: EventLog;
  maxHistoryMessages?: number;
  memoryManager?: MemoryManager;
};

// Per-session concurrency lock — same session requests queue, cross-session parallel
const sessionLocks = new Map<string, { promise: Promise<void>; count: number }>();

function withSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const entry = sessionLocks.get(sessionId);
  const prev = entry?.promise ?? Promise.resolve();
  const count = (entry?.count ?? 0) + 1;
  let unlock: () => void;
  const next = new Promise<void>((r) => (unlock = r));
  sessionLocks.set(sessionId, { promise: next, count });
  return prev.then(() => fn()).finally(() => {
    unlock();
    const current = sessionLocks.get(sessionId);
    if (current) {
      current.count--;
      if (current.count <= 0) {
        sessionLocks.delete(sessionId);
      }
    }
  });
}

export function chatRouter(
  app: Hono,
  provider: ChatProvider,
  deps: ChatRouterDeps,
): void {
  const { sessionManager, eventLog, memoryManager } = deps;
  const maxHistoryMessages = deps.maxHistoryMessages ?? 40;

  app.post("/api/chat", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = body.message;
    const sessionId: string | undefined = body.sessionId;

    if (!message || typeof message !== "string") {
      return c.json({ error: "message is required" }, 400);
    }

    // 1. Resolve or create session
    const userId = c.get("userId") ?? "web-anonymous";
    let session = sessionId ? sessionManager.getById(sessionId) : null;
    if (!session) {
      session = sessionManager.create({
        userId,
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

      // 5a. Inject relevant memories
      if (memoryManager) {
        try {
          const memories = memoryManager.search(session.userId, message);
          if (memories.length > 0) {
            const memoryText = memories
              .map((m) => `- [${m.category}] ${m.key}: ${m.value}`)
              .join("\n");
            rawHistory.unshift({
              role: "system",
              content: `你了解该用户的以下信息:\n${memoryText}`,
            });
          }
        } catch {
          // Best-effort — skip memory injection on error
        }
      }

      // 5b. Build memoryFlush callback
      const memoryFlush: MemoryFlushFn | undefined =
        memoryManager && provider.summarize
          ? async (early) => {
              const items = await extractMemories(early, (prompt) =>
                provider.summarize!(
                  [{ role: "user", content: prompt }],
                ),
              );
              if (items.length > 0) {
                memoryManager.save(session.userId, items, session.id);
              }
            }
          : undefined;

      const history = await compactHistory(rawHistory, {
        maxMessages: maxHistoryMessages,
        summarize: provider.summarize?.bind(provider),
        memoryFlush,
      });

      return streamSSE(c, async (stream) => {
        let assistantText = "";
        // SSE heartbeat — prevents browser/proxy from closing idle connections
        // during long tool execution gaps
        const heartbeat = setInterval(async () => {
          try {
            await stream.writeSSE({ data: "", event: "heartbeat" });
          } catch {
            // Stream already closed — will be cleaned up below
          }
        }, 15_000);

        try {
          // 6. Stream from provider
          for await (const event of provider.stream({
            message,
            sessionId: session.providerSessionId ?? undefined,
            history,
            abortSignal: c.req.raw.signal,
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

              // 10. Audit log (non-blocking)
              try {
                eventLog.log(createHubEvent({
                  type: "chat.web",
                  source: "web_chat",
                  payload: { message },
                  context: { sessionId: session.id },
                }));
              } catch { /* best-effort */ }
            } else {
              await stream.writeSSE({ data: JSON.stringify(event) });
            }
          }
        } catch (err: any) {
          console.error("[chat] Stream error:", err.message ?? err);
          try {
            await stream.writeSSE({
              data: JSON.stringify({
                type: "error",
                message: "Stream interrupted: " + (err.message ?? "unknown error"),
              }),
            });
            // Save partial response if any
            if (assistantText) {
              sessionManager.appendMessage(session.id, {
                role: "assistant",
                content: assistantText,
              });
            }
            await stream.writeSSE({
              data: JSON.stringify({
                type: "done",
                sessionId: session.id,
                costUsd: 0,
              }),
            });
          } catch {
            // Stream already closed — nothing more we can do
          }
        } finally {
          clearInterval(heartbeat);
        }
      });
    });
  });
}
