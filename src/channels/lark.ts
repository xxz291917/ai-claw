/**
 * LarkChannel — Lark (Feishu) webhook channel.
 *
 * Receives Feishu event callbacks, responds immediately with `{ code: 0 }`
 * (Lark requires < 3 s), then processes messages asynchronously using the
 * shared conversation pipeline.
 *
 * Group chat strategy:
 * - ALL messages are stored to the session for context accumulation
 * - Only @mentioned messages trigger AI response
 * - Silent messages use cheap sliding-window truncation (no AI summarize)
 * - @mentioned messages go through full handleConversation with AI compaction
 */

import type { Channel, ChannelContext } from "./types.js";
import type { ChatProvider } from "../chat/types.js";
import type { LarkConfig } from "../lark/client.js";
import { createLarkClient, sendCard, patchCard, fetchBotOpenId } from "../lark/client.js";
import { handleConversation, type ConversationDeps } from "../chat/conversation.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type LarkChannelConfig = {
  provider: ChatProvider;
  lark: LarkConfig;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  /** Max silent messages before sliding-window truncation. Default: 100. */
  maxSilentMessages?: number;
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
      mentions?: Array<{ id: { open_id: string }; key: string }>;
    };
  };
};

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class LarkChannel implements Channel {
  readonly name = "lark";
  private client!: ReturnType<typeof createLarkClient>;
  private botOpenId?: string;

  constructor(private config: LarkChannelConfig) {}

  async start(ctx: ChannelContext): Promise<void> {
    const { app } = ctx;

    // Create Lark SDK client
    this.client = createLarkClient(this.config.lark);

    // Use pre-configured open_id or fetch from API
    if (this.config.lark.openId) {
      this.botOpenId = this.config.lark.openId;
      log.info(`[lark] bot open_id (from config): ${this.botOpenId}`);
    } else {
      try {
        this.botOpenId = await fetchBotOpenId(this.client);
        log.info(`[lark] bot open_id (from API): ${this.botOpenId}`);
      } catch (err: any) {
        log.warn(`[lark] failed to fetch bot open_id: ${err.message} — group @mention detection disabled`);
      }
    }

    app.post("/api/lark/webhook", async (c) => {
      const body = await c.req.json().catch(() => ({}));

      // 1. Token verification — reject forged requests
      const { verificationToken } = this.config.lark;
      const incomingToken = body.token ?? body.header?.token;
      if (verificationToken && incomingToken !== verificationToken) {
        log.warn("[lark] webhook token mismatch — rejecting request");
        return c.json({ code: 0 });
      }

      // 2. URL verification challenge
      if (body.type === "url_verification") {
        const verification = body as LarkUrlVerification;
        return c.json({ challenge: verification.challenge });
      }

      // 3. Must be a v2 event
      if (body.schema !== "2.0" || !body.event?.message) {
        return c.json({ code: 0 });
      }

      const event = body as LarkEventV2;
      const { message, sender } = event.event;
      log.debug(`[lark] webhook: chat_type=${message.chat_type} message_id=${message.message_id} chat_id=${message.chat_id}`);

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

      // 6. Determine user identity
      const openId = sender.sender_id.open_id;
      const chatId = message.chat_id;
      const isGroup = message.chat_type === "group";
      // Group chat: shared team identity (shared session/workflow/memory)
      // P2P chat: individual identity (isolated session/memory)
      const userId = isGroup
        ? `lark-group:${chatId}`
        : `lark:${openId}`;

      // 7. Group chat: check if bot is @mentioned
      const isMentioned = isGroup && this.botOpenId
        ? message.mentions?.some((m) => m.id?.open_id === this.botOpenId) ?? false
        : !isGroup; // P2P always treated as "mentioned"

      // Strip @mention placeholders (e.g. @_user_1) from message text
      if (message.mentions?.length) {
        for (const m of message.mentions) {
          if (m.key) text = text.replace(m.key, "");
        }
        text = text.trim();
      }

      if (!text.trim()) {
        return c.json({ code: 0 });
      }

      if (isMentioned) {
        // @mentioned or P2P → full AI response
        this.processMessage(ctx, userId, chatId, text).catch((err) => {
          log.error("[lark] async processing error:", err);
        });
      } else {
        // Group message without @mention → silent store only
        this.storeSilentMessage(ctx, userId, chatId, openId, text).catch((err) => {
          log.error("[lark] silent store error:", err);
        });
      }

      return c.json({ code: 0 });
    });
  }

  // ---------------------------------------------------------------------------
  // Silent message storage (group chat, not @mentioned)
  // ---------------------------------------------------------------------------

  private async storeSilentMessage(
    ctx: ChannelContext,
    userId: string,
    chatId: string,
    senderOpenId: string,
    text: string,
  ): Promise<void> {
    const { sessionManager } = ctx;

    // Find or create session
    let session = sessionManager.findActive(userId, "lark");
    if (!session) {
      session = sessionManager.create({
        userId,
        channel: "lark",
        channelId: chatId,
        provider: this.config.provider.name,
      });
    }

    // Append as user message with sender tag for context
    sessionManager.appendMessage(session.id, {
      role: "user",
      content: `[${senderOpenId}] ${text}`,
    });

    // Sliding-window truncation: cheap, no AI call
    const maxSilent = this.config.maxSilentMessages ?? 100;
    const keep = Math.floor(maxSilent * 0.75);
    const trimmed = sessionManager.trimMessages(session.id, maxSilent, keep, "group messages");
    if (trimmed > 0) {
      log.info(`[lark] silent compact: removed ${trimmed} messages (chat=${chatId})`);
    }
  }

  // ---------------------------------------------------------------------------
  // Full message processing (@mentioned or P2P)
  // ---------------------------------------------------------------------------

  private async processMessage(
    ctx: ChannelContext,
    userId: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    const { sessionManager, eventLog, memoryManager } = ctx;
    const { provider } = this.config;
    const { client } = this;

    // 1. Send "thinking" card
    const cardMessageId = await sendCard(client, chatId, "思考中...");

    // 2. Find or reuse existing session
    const existingSession = sessionManager.findActive(userId, "lark");
    const sessionId = existingSession?.id;

    // 3. Build conversation deps
    const convDeps: ConversationDeps = {
      provider,
      sessionManager,
      eventLog,
      memoryManager,
      maxHistoryMessages: this.config.maxHistoryMessages,
      maxHistoryTokens: this.config.maxHistoryTokens,
    };

    // 4. Run conversation pipeline (handles compaction with AI summarize)
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
      await patchCard(client, cardMessageId, reply);
    } catch (err: any) {
      log.error("[lark] conversation error:", err.message ?? err);
      try {
        await patchCard(client, cardMessageId, `出错了: ${err.message ?? "unknown error"}`);
      } catch {
        /* best-effort */
      }
    }
  }
}
