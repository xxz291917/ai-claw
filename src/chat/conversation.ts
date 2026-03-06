/**
 * Core conversation pipeline — shared by Web chat (SSE) and Lark bot channels.
 *
 * Handles: session resolution, user message persistence, history loading,
 * memory injection, compaction, provider streaming (collected, not streamed),
 * assistant reply persistence, provider session ID binding, and audit logging.
 */

import type { ChatProvider, ChatEvent } from "./types.js";
import type { SessionManager } from "../sessions/manager.js";
import type { EventLog } from "../core/event-bus.js";
import { createHubEvent } from "../core/hub-event.js";
import type { MemoryManager } from "../memory/manager.js";
import type { UserSettingsManager } from "../settings/manager.js";
import type { MemoryFlushFn } from "./compaction.js";
import { compactHistory } from "./compaction.js";
import { extractMemories } from "../memory/extractor.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConversationDeps = {
  provider: ChatProvider;
  sessionManager: SessionManager;
  eventLog: EventLog;
  memoryManager?: MemoryManager;
  userSettingsManager?: UserSettingsManager;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
};

export type ConversationRequest = {
  userId: string;
  message: string;
  sessionId?: string;
  channel: string;
  channelId: string;
  deps: ConversationDeps;
  abortSignal?: AbortSignal;
  /** Optional callback invoked for each event as it arrives — enables real-time SSE streaming. */
  onEvent?: (event: ChatEvent) => void | Promise<void>;
};

export type ConversationResult = {
  text: string;
  sessionId: string;
  costUsd: number;
  events: ChatEvent[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Per-session concurrency lock
// ---------------------------------------------------------------------------

const sessionLocks = new Map<string, { promise: Promise<void>; count: number }>();

export function withSessionLock<T>(
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

// ---------------------------------------------------------------------------
// handleConversation
// ---------------------------------------------------------------------------

export async function handleConversation(
  req: ConversationRequest,
): Promise<ConversationResult> {
  const t0 = Date.now();
  const { userId, message, channel, channelId, deps, abortSignal } = req;
  const { provider, sessionManager, eventLog, memoryManager, userSettingsManager } = deps;
  const maxHistoryMessages = deps.maxHistoryMessages ?? 40;
  const maxHistoryTokens = deps.maxHistoryTokens ?? 0;

  // 1. Resolve or create session
  let session = req.sessionId ? sessionManager.getById(req.sessionId) : null;

  // Don't reuse a session that belongs to a different user
  if (session && session.userId !== userId) {
    log.info(
      `[conversation] session ${session.id} belongs to ${session.userId}, not ${userId} — creating new`,
    );
    session = null;
  }

  if (!session) {
    session = sessionManager.create({
      userId,
      channel,
      channelId,
      provider: provider.name,
    });
    log.info(`[conversation] new session ${session.id} for user=${userId}`);
  } else {
    log.info(`[conversation] reuse session ${session.id} user=${userId}`);
  }

  const sessionId = session.id;

  // 2. Per-session lock — queue concurrent requests for same session
  return withSessionLock(sessionId, async () => {
    // 3. Record user message
    sessionManager.appendMessage(sessionId, {
      role: "user",
      content: message,
    });

    // 4. Build per-request context (user identity + memories)
    let memoryText: string | null = null;
    if (memoryManager) {
      try {
        const memories = memoryManager.search(session.userId, message);
        log.info(`[conversation] memory search: ${memories.length} results`);
        if (memories.length > 0) {
          memoryText = memories
            .map((m) => `- id=${m.id} [${m.category}] ${m.key}: ${m.value}`)
            .join("\n");
        }
      } catch {
        // Best-effort — skip memory on error
      }
    }

    const identityParts: string[] = [];
    identityParts.push(`当前用户: ${session.userId}`);
    if (memoryText) {
      identityParts.push(`你了解该用户的以下信息:\n${memoryText}`);
    }
    const customPrompt = userSettingsManager?.getCustomPrompt(session.userId);
    if (customPrompt) {
      identityParts.push(`用户自定义偏好和指令 (优先遵守):\n${customPrompt}`);
    }
    const systemPromptAddition = identityParts.join("\n\n");

    // 4a. Native context providers (e.g. ClaudeProvider with SDK resume) manage their own history.
    //     Skip history loading/compaction — pass context via systemPromptAddition only.
    let history: Array<{ role: "user" | "assistant" | "system"; content: string }> | undefined;

    if (!provider.usesNativeContext) {
      const rawHistory = sessionManager.getMessages(sessionId).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      log.info(`[conversation] history: ${rawHistory.length} messages`);

      // Build memoryFlush callback for compaction
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
                memoryManager.save(session.userId, items, sessionId);
              }
            }
          : undefined;

      const compacted = await compactHistory(rawHistory, {
        maxMessages: maxHistoryMessages,
        maxTokens: maxHistoryTokens,
        summarize: provider.summarize?.bind(provider),
        memoryFlush,
      });

      // Persist compacted history so subsequent requests don't re-summarize
      if (compacted.length < rawHistory.length) {
        const keepCount = compacted.length - 1; // exclude the summary message
        log.info(
          `[conversation] compacted ${rawHistory.length} → ${compacted.length} messages (keep=${keepCount}), persisting (${Date.now() - t0}ms)`,
        );
        sessionManager.compactMessages(sessionId, keepCount, compacted[0]);
      } else {
        log.info(
          `[conversation] history: ${compacted.length} messages, no compaction needed (${Date.now() - t0}ms)`,
        );
      }

      // Inject user identity + memories as system message — never persisted
      compacted.unshift({
        role: "system",
        content: systemPromptAddition,
      });

      history = compacted;
    } else {
      log.info(`[conversation] native context provider — skipping history (${Date.now() - t0}ms)`);
    }

    // 5. Stream from provider — collect ALL events
    let assistantText = "";
    let costUsd = 0;
    const events: ChatEvent[] = [];

    try {
      log.info(
        `[conversation] → provider.stream() provider=${provider.name} (${Date.now() - t0}ms)`,
      );
      for await (const event of provider.stream({
        message,
        sessionId: session.providerSessionId ?? undefined,
        history,
        systemPromptAddition,
        abortSignal,
        toolContext: { userId: session.userId, sessionId },
      })) {
        events.push(event);
        await req.onEvent?.(event);

        if (event.type === "text") {
          assistantText += event.content;
        }

        if (event.type === "tool_use") {
          log.info(
            `[conversation]   tool_use: ${(event as any).tool} (${Date.now() - t0}ms)`,
          );
        }
        if (event.type === "tool_result") {
          const output = (event as any).output ?? "";
          log.info(
            `[conversation]   tool_result: ${(event as any).tool} (${output.length} chars, ${Date.now() - t0}ms)`,
          );
        }

        if (event.type === "done") {
          costUsd = (event as any).costUsd ?? 0;
          log.info(
            `[conversation] done (${Date.now() - t0}ms) cost=$${costUsd} text=${assistantText.length} chars`,
          );

          // 6. Record assistant reply
          if (assistantText) {
            sessionManager.appendMessage(sessionId, {
              role: "assistant",
              content: assistantText,
            });
          }

          // 7. Store provider session ID
          if (event.sessionId) {
            sessionManager.updateProviderSessionId(sessionId, event.sessionId);
          }

          // 8. Audit log (non-blocking)
          try {
            eventLog.log(
              createHubEvent({
                type: `chat.${channel}`,
                source: `${channel}_chat`,
                payload: { message },
                context: { sessionId },
              }),
            );
          } catch {
            /* best-effort */
          }
        }
      }
    } catch (err: any) {
      log.error("[conversation] Stream error:", err.message ?? err);

      // Save partial response if any
      if (assistantText) {
        sessionManager.appendMessage(sessionId, {
          role: "assistant",
          content: assistantText,
        });
      }

      return {
        text: assistantText,
        sessionId,
        costUsd,
        events,
        error: err.message ?? String(err),
      };
    }

    return {
      text: assistantText,
      sessionId,
      costUsd,
      events,
    };
  });
}
