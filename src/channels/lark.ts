/**
 * LarkChannel — Lark (Feishu) webhook channel.
 *
 * Receives Feishu event callbacks, responds immediately with `{ code: 0 }`
 * (Lark requires < 3 s), then processes messages asynchronously using the
 * shared conversation pipeline.
 *
 * Pattern: send a "thinking" card -> run handleConversation -> patch the card
 * with the final reply.
 */

import type { Channel, ChannelContext } from "./types.js";
import type { ChatProvider } from "../chat/types.js";
import { handleConversation, type ConversationDeps } from "../chat/conversation.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type LarkChannelConfig = {
  provider: ChatProvider;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  sendCard: (chatId: string, markdown: string) => Promise<string>;
  patchCard: (messageId: string, markdown: string) => Promise<void>;
  /** Fetch recent group chat messages for context injection. */
  fetchGroupContext?: (chatId: string, afterMessageId?: string) => Promise<string>;
  verificationToken?: string;
};

// ---------------------------------------------------------------------------
// Message dedup cache — message_id -> timestamp, 5 min TTL
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
// Channel
// ---------------------------------------------------------------------------

export class LarkChannel implements Channel {
  readonly name = "lark";

  /** Track last seen message_id per chatId for incremental context fetching. */
  private lastMessageId = new Map<string, string>();

  constructor(private config: LarkChannelConfig) {}

  async start(ctx: ChannelContext): Promise<void> {
    const { app } = ctx;

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
      // Group chat: shared team identity (shared session/workflow/memory)
      // P2P chat: individual identity (isolated session/memory)
      const userId = message.chat_type === "group"
        ? `lark-group:${chatId}`
        : `lark:${openId}`;

      const isGroup = message.chat_type === "group";

      // Kick off async processing (not awaited)
      this.processMessage(ctx, userId, chatId, text, isGroup, message.message_id).catch((err) => {
        console.error("[lark] async processing error:", err);
      });

      return c.json({ code: 0 });
    });
  }

  // ---------------------------------------------------------------------------
  // Async message processing
  // ---------------------------------------------------------------------------

  private async processMessage(
    ctx: ChannelContext,
    userId: string,
    chatId: string,
    text: string,
    isGroup?: boolean,
    messageId?: string,
  ): Promise<void> {
    const { sessionManager, eventLog, memoryManager } = ctx;
    const { provider, sendCard, patchCard, fetchGroupContext } = this.config;

    // 1. Send "thinking" card
    const cardMessageId = await sendCard(chatId, "思考中...");

    // 2. For group chats, fetch incremental context
    let enrichedText = text;
    if (isGroup && fetchGroupContext) {
      try {
        const afterId = this.lastMessageId.get(chatId);
        const context = await fetchGroupContext(chatId, afterId);
        if (context) {
          enrichedText = `[群聊上下文]\n${context}\n\n[当前消息]\n${text}`;
        }
      } catch (err: any) {
        console.error("[lark] fetch group context error:", err.message ?? err);
        // Non-fatal: proceed without context
      }
    }
    // Update last seen message_id for next incremental fetch
    if (messageId) {
      this.lastMessageId.set(chatId, messageId);
    }

    // 3. Find or reuse existing session
    const existingSession = sessionManager.findActive(userId, "lark");
    const sessionId = existingSession?.id;

    // 4. Build conversation deps
    const convDeps: ConversationDeps = {
      provider,
      sessionManager,
      eventLog,
      memoryManager,
      maxHistoryMessages: this.config.maxHistoryMessages,
      maxHistoryTokens: this.config.maxHistoryTokens,
    };

    // 5. Run conversation pipeline
    try {
      const result = await handleConversation({
        userId,
        message: enrichedText,
        sessionId,
        channel: "lark",
        channelId: chatId,
        deps: convDeps,
      });

      // 6. Patch the card with the final reply
      const reply = result.text || result.error || "\uFF08\u65E0\u56DE\u590D\uFF09";
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
}
