import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatProvider } from "./types.js";
import type { SessionManager } from "../sessions/manager.js";
import type { EventLog } from "../core/event-bus.js";
import type { MemoryManager } from "../memory/manager.js";
import { handleCommand } from "./commands.js";
import { handleConversation, type ConversationDeps } from "./conversation.js";

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

export function chatRouter(
  app: Hono,
  provider: ChatProvider,
  deps: ChatRouterDeps,
): void {
  const { sessionManager, eventLog, memoryManager } = deps;

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

    // 3. Delegate to handleConversation with real-time SSE streaming
    const convDeps: ConversationDeps = {
      provider,
      sessionManager,
      eventLog,
      memoryManager,
      maxHistoryMessages: deps.maxHistoryMessages,
      maxHistoryTokens: deps.maxHistoryTokens,
    };

    const resolvedSessionId = session.id;

    return streamSSE(c, async (stream) => {
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
        const result = await handleConversation({
          userId,
          message,
          sessionId: resolvedSessionId,
          channel: "web",
          channelId: "",
          deps: convDeps,
          abortSignal: c.req.raw.signal,
          onEvent: async (event) => {
            if (event.type === "done") {
              // Replace provider sessionId with our app session ID
              await stream.writeSSE({
                data: JSON.stringify({ ...event, sessionId: resolvedSessionId }),
              });
            } else {
              await stream.writeSSE({ data: JSON.stringify(event) });
            }
          },
        });

        console.log(`[chat] done (${Date.now() - t0}ms)`);

        // If there was an error, send error + done events
        // (these weren't emitted by the provider, so onEvent didn't fire them)
        if (result.error) {
          try {
            await stream.writeSSE({
              data: JSON.stringify({
                type: "error",
                message: "Stream interrupted: " + result.error,
              }),
            });
            await stream.writeSSE({
              data: JSON.stringify({
                type: "done",
                sessionId: resolvedSessionId,
                costUsd: result.costUsd,
              }),
            });
          } catch {
            // Stream already closed — nothing more we can do
          }
        }
      } catch (err: any) {
        // Unexpected error not caught by handleConversation
        console.error("[chat] Unexpected error:", err.message ?? err);
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              type: "error",
              message: "Stream interrupted: " + (err.message ?? "unknown error"),
            }),
          });
          await stream.writeSSE({
            data: JSON.stringify({
              type: "done",
              sessionId: resolvedSessionId,
              costUsd: 0,
            }),
          });
        } catch {
          // Stream already closed
        }
      } finally {
        clearInterval(heartbeat);
      }
    });
  });
}
