/**
 * Lark (Feishu) webhook router.
 *
 * Receives Feishu event callbacks, responds immediately with `{ code: 0 }`
 * (Lark requires < 3 s), then processes messages asynchronously using the
 * shared conversation pipeline.
 *
 * Pattern: send a "thinking" card → run handleConversation → patch the card
 * with the final reply.
 */

import type { Hono } from "hono";
import type { ChatProvider } from "../chat/types.js";
import type { SessionManager } from "../sessions/manager.js";
import type { EventLog } from "../core/event-bus.js";
import type { MemoryManager } from "../memory/manager.js";
import { handleConversation, type ConversationDeps } from "../chat/conversation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LarkRouterDeps = {
  provider: ChatProvider;
  sessionManager: SessionManager;
  eventLog: EventLog;
  memoryManager?: MemoryManager;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  sendCard: (chatId: string, markdown: string) => Promise<string>;
  patchCard: (messageId: string, markdown: string) => Promise<void>;
  verificationToken?: string;
};

// ---------------------------------------------------------------------------
// Message dedup cache — message_id → timestamp, 5 min TTL
// ---------------------------------------------------------------------------

const DEDUP_TTL_MS = 5 * 60 * 1000;

const seenMessages = new Map<string, number>();

function isDuplicate(messageId: string): boolean {
  const now = Date.now();

  // Lazy cleanup: remove expired entries
  if (seenMessages.size > 1000) {
    for (const [key, ts] of seenMessages) {
      if (now - ts > DEDUP_TTL_MS) seenMessages.delete(key);
    }
  }

  if (seenMessages.has(messageId)) {
    const ts = seenMessages.get(messageId)!;
    if (now - ts < DEDUP_TTL_MS) return true;
  }

  seenMessages.set(messageId, now);
  return false;
}

// ---------------------------------------------------------------------------
// Lark event body types (minimal)
// ---------------------------------------------------------------------------

type LarkUrlVerification = {
  type: "url_verification";
  token: string;
  challenge: string;
};

type LarkEventV2 = {
  schema: "2.0";
  header: {
    event_id: string;
    event_type: string;
    token: string;
  };
  event: {
    sender: {
      sender_id: { open_id: string };
      sender_type: string;
    };
    message: {
      message_id: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
    };
  };
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function larkRouter(app: Hono, deps: LarkRouterDeps): void {
  app.post("/api/lark/webhook", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // 1. URL verification challenge
    if (body.type === "url_verification") {
      const verification = body as LarkUrlVerification;
      return c.json({ challenge: verification.challenge });
    }

    // 2. Must be a v2 event
    if (body.schema !== "2.0" || !body.event?.message) {
      return c.json({ code: 0 });
    }

    const event = body as LarkEventV2;
    const { message, sender } = event.event;

    // 3. Only handle text messages
    if (message.message_type !== "text") {
      return c.json({ code: 0 });
    }

    // 4. Dedup by message_id
    if (isDuplicate(message.message_id)) {
      return c.json({ code: 0 });
    }

    // 5. Extract text content
    let text: string;
    try {
      const parsed = JSON.parse(message.content);
      text = parsed.text ?? "";
    } catch {
      text = "";
    }

    if (!text.trim()) {
      return c.json({ code: 0 });
    }

    // 6. Fire-and-forget: respond immediately, process async
    const openId = sender.sender_id.open_id;
    const chatId = message.chat_id;
    const userId = `lark:${openId}`;

    // Kick off async processing (not awaited)
    processMessage(deps, userId, chatId, text).catch((err) => {
      console.error("[lark] async processing error:", err);
    });

    return c.json({ code: 0 });
  });
}

// ---------------------------------------------------------------------------
// Async message processing
// ---------------------------------------------------------------------------

async function processMessage(
  deps: LarkRouterDeps,
  userId: string,
  chatId: string,
  text: string,
): Promise<void> {
  const {
    provider,
    sessionManager,
    eventLog,
    memoryManager,
    sendCard,
    patchCard,
  } = deps;

  // 1. Send "thinking" card
  const cardMessageId = await sendCard(chatId, "思考中...");

  // 2. Find or reuse existing session
  const existingSession = sessionManager.findActive(userId, "lark");
  const sessionId = existingSession?.id;

  // 3. Build conversation deps
  const convDeps: ConversationDeps = {
    provider,
    sessionManager,
    eventLog,
    memoryManager,
    maxHistoryMessages: deps.maxHistoryMessages,
    maxHistoryTokens: deps.maxHistoryTokens,
  };

  // 4. Run conversation pipeline
  try {
    const result = await handleConversation({
      userId,
      message: text,
      sessionId,
      channel: "lark",
      channelId: chatId,
      deps: convDeps,
    });

    // 5. Patch the card with the final reply
    const reply = result.text || result.error || "（无回复）";
    await patchCard(cardMessageId, reply);
  } catch (err: any) {
    console.error("[lark] conversation error:", err.message ?? err);
    try {
      await patchCard(cardMessageId, `出错了: ${err.message ?? "unknown error"}`);
    } catch {
      /* best-effort */
    }
  }
}
