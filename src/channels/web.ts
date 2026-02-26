import type { Channel, ChannelContext } from "./types.js";
import type { ChatProvider } from "../chat/types.js";
import type { SubagentManager } from "../subagent/manager.js";
import { streamSSE } from "hono/streaming";
import { handleCommand } from "../chat/commands.js";
import { handleConversation, type ConversationDeps } from "../chat/conversation.js";
import { log } from "../logger.js";

export type WebChannelConfig = {
  provider: ChatProvider;
  maxHistoryMessages?: number;
  /** Max estimated tokens before triggering compaction. 0 = disabled. */
  maxHistoryTokens?: number;
  /** Skill directories — used to derive the writable install dir for /install */
  skillsDirs: string[];
  subagentManager?: SubagentManager;
};

export class WebChannel implements Channel {
  readonly name = "web";

  constructor(private config: WebChannelConfig) {}

  async start(ctx: ChannelContext): Promise<void> {
    const { app, sessionManager, eventLog, memoryManager } = ctx;
    const { provider, skillsDirs } = this.config;

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

      log.info(`[chat] <- message="${message.slice(0, 80)}" sessionId=${sessionId ?? "(new)"}`);

      // 1. Resolve or create session
      const userId = c.get("userId") ?? "web-anonymous";
      let session = sessionId ? sessionManager.getById(sessionId) : null;

      // Don't reuse a session that belongs to a different user
      // (e.g. old anonymous session after the user logs in with a token)
      if (session && session.userId !== userId) {
        log.info(`[chat] session ${session.id} belongs to ${session.userId}, not ${userId} -- creating new`);
        session = null;
      }

      if (!session) {
        session = sessionManager.create({
          userId,
          channel: "web",
          channelId: "",
          provider: provider.name,
        });
        log.info(`[chat] new session ${session.id} for user=${userId}`);
      } else {
        log.info(`[chat] reuse session ${session.id} user=${userId}`);
      }

      // 2. Handle slash commands (before LLM call)
      const installDir = skillsDirs[1] ?? skillsDirs[0];
      const cmdResult = await handleCommand(message, {
        session,
        sessionManager,
        providerName: provider.name,
        installDir,
        skillsDirs,
        subagentManager: this.config.subagentManager,
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
        maxHistoryMessages: this.config.maxHistoryMessages,
        maxHistoryTokens: this.config.maxHistoryTokens,
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

          log.info(`[chat] done (${Date.now() - t0}ms)`);

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
          log.error("[chat] Unexpected error:", err.message ?? err);
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
}
