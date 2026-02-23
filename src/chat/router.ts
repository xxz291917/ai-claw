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
  /** Max estimated tokens before triggering compaction. 0 = disabled. */
  maxHistoryTokens?: number;
  memoryManager?: MemoryManager;
  /** Skill directories — used to derive the writable install dir for /install */
  skillsDirs: string[];
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
  const maxHistoryTokens = deps.maxHistoryTokens ?? 0;

  // Lightweight auth check — no session creation
  app.get("/api/chat", (c) => {
    const userId = c.get("userId") ?? "web-anonymous";
    return c.json({ status: "ok", userId });
  });

  app.post("/api/chat", async (c) => {
    const t0 = Date.now();
    const body = await c.req.json().catch(() => ({}));
    const message = body.message;
    const sessionId: string | undefined = body.sessionId;

    if (!message || typeof message !== "string") {
      return c.json({ error: "message is required" }, 400);
    }

    console.log(`[chat] ← message="${message.slice(0, 80)}" sessionId=${sessionId ?? "(new)"}`);

    // 1. Resolve or create session
    const userId = c.get("userId") ?? "web-anonymous";
    let session = sessionId ? sessionManager.getById(sessionId) : null;

    // Don't reuse a session that belongs to a different user
    // (e.g. old anonymous session after the user logs in with a token)
    if (session && session.userId !== userId) {
      console.log(`[chat] session ${session.id} belongs to ${session.userId}, not ${userId} — creating new`);
      session = null;
    }

    if (!session) {
      session = sessionManager.create({
        userId,
        channel: "web",
        channelId: "",
        provider: provider.name,
      });
      console.log(`[chat] new session ${session.id} for user=${userId}`);
    } else {
      console.log(`[chat] reuse session ${session.id} user=${userId}`);
    }

    // 2. Handle slash commands (before LLM call)
    const installDir = deps.skillsDirs[1] ?? deps.skillsDirs[0];
    const cmdResult = await handleCommand(message, {
      session,
      sessionManager,
      providerName: provider.name,
      installDir,
      skillsDirs: deps.skillsDirs,
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

      console.log(`[chat] history: ${rawHistory.length} messages`);

      // 5a. Search relevant memories (inject after compaction)
      let memoryText: string | null = null;
      if (memoryManager) {
        try {
          const memories = memoryManager.search(session.userId, message);
          console.log(`[chat] memory search: ${memories.length} results`);
          if (memories.length > 0) {
            memoryText = memories
              .map((m) => `- id=${m.id} [${m.category}] ${m.key}: ${m.value}`)
              .join("\n");
          }
        } catch {
          // Best-effort — skip memory on error
        }
      }

      // 5b. Build memoryFlush callback
      const memoryFlush: MemoryFlushFn | undefined =
        memoryManager && provider.summarize
          ? async (early) => {
              const existing = memoryManager.getByUser(session.userId);
              const items = await extractMemories(
                early,
                (prompt) =>
                  provider.summarize!(
                    [{ role: "user", content: prompt }],
                  ),
                existing,
              );
              if (items.length > 0) {
                memoryManager.save(session.userId, items, session.id);
              }
            }
          : undefined;

      const history = await compactHistory(rawHistory, {
        maxMessages: maxHistoryMessages,
        maxTokens: maxHistoryTokens,
        summarize: provider.summarize?.bind(provider),
        memoryFlush,
      });

      // Persist compacted history so subsequent requests don't re-summarize
      if (history.length < rawHistory.length) {
        const keepCount = history.length - 1; // exclude the summary message
        console.log(`[chat] compacted ${rawHistory.length} → ${history.length} messages (keep=${keepCount}), persisting (${Date.now() - t0}ms)`);
        sessionManager.compactMessages(session.id, keepCount, history[0]);
      } else {
        console.log(`[chat] history: ${history.length} messages, no compaction needed (${Date.now() - t0}ms)`);
      }

      // 5c. Inject user identity + memories AFTER compaction — always present for LLM, never persisted
      const identityParts: string[] = [];
      identityParts.push(`当前用户: ${session.userId}`);
      if (memoryText) {
        identityParts.push(`你了解该用户的以下信息:\n${memoryText}`);
      }
      history.unshift({
        role: "system",
        content: identityParts.join("\n\n"),
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
          console.log(`[chat] → provider.stream() provider=${provider.name} (${Date.now() - t0}ms)`);
          for await (const event of provider.stream({
            message,
            sessionId: session.providerSessionId ?? undefined,
            history,
            abortSignal: c.req.raw.signal,
            toolContext: { userId: session.userId, sessionId: session.id },
          })) {
            if (event.type === "text") {
              assistantText += event.content;
            }

            if (event.type === "tool_use") {
              console.log(`[chat]   tool_use: ${(event as any).tool} (${Date.now() - t0}ms)`);
            }
            if (event.type === "tool_result") {
              const output = (event as any).output ?? "";
              console.log(`[chat]   tool_result: ${(event as any).tool} (${output.length} chars, ${Date.now() - t0}ms)`);
            }

            if (event.type === "done") {
              console.log(`[chat] ✓ done (${Date.now() - t0}ms) cost=$${(event as any).costUsd ?? 0} text=${assistantText.length} chars`);
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
