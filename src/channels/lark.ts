/**
 * LarkChannel — Lark (Feishu) channel.
 *
 * Supports two connection modes:
 * - **ws** (default): WebSocket long connection via SDK's WSClient.
 *   No public URL needed; SDK handles reconnect, heartbeat, and dedup.
 * - **webhook**: Traditional HTTP callback on POST /api/lark/webhook.
 *   Requires a public URL reachable by Lark servers.
 *
 * Group chat strategy:
 * - ALL messages are stored to the session for context accumulation
 * - Only @mentioned messages trigger AI response
 * - Silent messages use cheap sliding-window truncation (no AI summarize)
 * - @mentioned messages go through full handleConversation with AI compaction
 */

import * as lark from "@larksuiteoapi/node-sdk";
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
  lark?: LarkConfig;
  mode: "webhook" | "ws";
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  /** Max silent messages before sliding-window truncation. Default: 100. */
  maxSilentMessages?: number;
  /** Override sendCard for testing. */
  sendCard?: (chatId: string, markdown: string) => Promise<string>;
  /** Override patchCard for testing. */
  patchCard?: (messageId: string, markdown: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Message dedup cache (webhook mode only) — message_id -> timestamp, 5 min TTL
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
// Lark event body types (minimal — shared by both modes)
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
  event: LarkMessageEventData;
};

type LarkMessageEventData = {
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

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class LarkChannel implements Channel {
  readonly name = "lark";
  private client!: ReturnType<typeof createLarkClient>;
  private botOpenId?: string;
  private wsClient?: lark.WSClient;

  constructor(private config: LarkChannelConfig) {}

  async start(ctx: ChannelContext): Promise<void> {
    // Create Lark SDK client (for sending messages via REST API)
    if (this.config.lark) {
      this.client = createLarkClient(this.config.lark);
      await this.resolveBotOpenId();
    }

    if (this.config.mode === "ws") {
      await this.startWebSocket(ctx);
    } else {
      this.startWebhook(ctx);
    }
  }

  async stop(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close({ force: false });
      log.info("[lark] WebSocket connection closed");
    }
  }

  // ---------------------------------------------------------------------------
  // Bot open_id resolution
  // ---------------------------------------------------------------------------

  private async resolveBotOpenId(): Promise<void> {
    if (this.config.lark!.openId) {
      this.botOpenId = this.config.lark!.openId;
      log.info(`[lark] bot open_id (from config): ${this.botOpenId}`);
    } else {
      try {
        this.botOpenId = await fetchBotOpenId(this.client);
        log.info(`[lark] bot open_id (from API): ${this.botOpenId}`);
      } catch (err: any) {
        log.warn(`[lark] failed to fetch bot open_id: ${err.message} — group @mention detection disabled`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket mode
  // ---------------------------------------------------------------------------

  private async startWebSocket(ctx: ChannelContext): Promise<void> {
    const { appId, appSecret } = this.config.lark!;

    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: any) => {
        this.handleEvent(ctx, data as LarkMessageEventData, false);
      },
    });

    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain: lark.Domain.Lark,
      loggerLevel: lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    log.info("[lark] WebSocket long connection established");
  }

  // ---------------------------------------------------------------------------
  // Webhook mode
  // ---------------------------------------------------------------------------

  private startWebhook(ctx: ChannelContext): void {
    const { app } = ctx;

    app.post("/api/lark/webhook", async (c) => {
      const body = await c.req.json().catch(() => ({}));

      // 1. Token verification — reject forged requests
      const verificationToken = this.config.lark?.verificationToken;
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
      log.debug(`[lark] webhook: chat_type=${event.event.message.chat_type} message_id=${event.event.message.message_id}`);

      // 4. Dedup + handle
      this.handleEvent(ctx, event.event, true);

      return c.json({ code: 0 });
    });
  }

  // ---------------------------------------------------------------------------
  // Unified event handler (shared by both modes)
  // ---------------------------------------------------------------------------

  private handleEvent(ctx: ChannelContext, data: LarkMessageEventData, needDedup: boolean): void {
    const { message, sender } = data;

    // Only handle text messages
    if (message.message_type !== "text") return;

    // Webhook mode needs manual dedup; ws mode dedup is handled by SDK
    if (needDedup && isDuplicate(message.message_id)) return;

    // Extract text content
    let text: string;
    try {
      const parsed = JSON.parse(message.content);
      text = parsed.text ?? "";
    } catch {
      text = "";
    }

    if (!text.trim()) return;

    // Determine user identity
    const openId = sender.sender_id.open_id;
    const chatId = message.chat_id;
    const isGroup = message.chat_type === "group";
    // Group chat: shared team identity; P2P chat: individual identity
    const userId = isGroup ? `lark-group:${chatId}` : `lark:${openId}`;

    // Group chat: check if bot is @mentioned
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

    if (!text.trim()) return;

    if (isMentioned) {
      this.processMessage(ctx, userId, chatId, text).catch((err) => {
        log.error("[lark] async processing error:", err);
      });
    } else {
      this.storeSilentMessage(ctx, userId, chatId, openId, text).catch((err) => {
        log.error("[lark] silent store error:", err);
      });
    }
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
    const doSend = this.config.sendCard ?? ((cid, md) => sendCard(client, cid, md));
    const doPatch = this.config.patchCard ?? ((mid, md) => patchCard(client, mid, md));
    const cardMessageId = await doSend(chatId, "思考中...");

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
      await doPatch(cardMessageId, reply);
    } catch (err: any) {
      log.error("[lark] conversation error:", err.message ?? err);
      try {
        await doPatch(cardMessageId, `出错了: ${err.message ?? "unknown error"}`);
      } catch {
        /* best-effort */
      }
    }
  }
}
