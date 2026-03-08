import * as lark from "@larksuiteoapi/node-sdk";
import type { Env } from "../env.js";

export type LarkClient = lark.Client;

export function createLarkClient(env: Env): LarkClient {
  if (!env.LARK_APP_ID || !env.LARK_APP_SECRET) {
    throw new Error("LARK_APP_ID and LARK_APP_SECRET are required");
  }

  return new lark.Client({
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });
}

/** Build a markdown card JSON for interactive messages. */
export function buildMarkdownCard(text: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: "markdown", content: text }],
    },
  });
}

/** Send a new interactive card message to a chat. Returns the message_id. */
export async function sendCard(
  client: LarkClient,
  chatId: string,
  markdown: string,
): Promise<string> {
  const res = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      content: buildMarkdownCard(markdown),
      msg_type: "interactive",
    },
  });
  return res.data?.message_id ?? "";
}

/** Formatted group chat message for context injection. */
export type GroupChatMessage = {
  sender: string;
  time: string;
  text: string;
};

/**
 * Fetch recent messages from a chat, optionally after a given message_id.
 * Returns formatted messages (newest last) up to `limit`.
 */
export async function fetchRecentMessages(
  client: LarkClient,
  chatId: string,
  opts?: { afterMessageId?: string; limit?: number },
): Promise<GroupChatMessage[]> {
  const limit = opts?.limit ?? 20;

  const res = await client.im.message.list({
    params: {
      container_id_type: "chat",
      container_id: chatId,
      page_size: Math.min(limit, 50),
      sort_type: "ByCreateTimeDesc",
    },
  });
  const items = res.data?.items ?? [];

  // Filter to messages after the anchor (if provided)
  let filtered = items;
  if (opts?.afterMessageId) {
    const idx = filtered.findIndex(
      (m: any) => m.message_id === opts.afterMessageId,
    );
    if (idx >= 0) {
      // ByCreateTimeDesc: index 0 is newest, anchor is at idx → keep 0..idx-1
      filtered = filtered.slice(0, idx);
    }
  }

  // Take up to limit, reverse to chronological order (oldest first)
  const messages = filtered.slice(0, limit).reverse();

  return messages.map((m: any) => {
    let text = "";
    if (m.msg_type === "text") {
      try {
        const parsed = JSON.parse(m.body?.content ?? "{}");
        text = parsed.text ?? "";
      } catch {
        text = m.body?.content ?? "";
      }
    } else {
      text = `[${m.msg_type}]`;
    }

    const senderName =
      m.sender?.sender_type === "app"
        ? "Bot"
        : m.sender?.id ?? "unknown";

    const time = m.create_time
      ? new Date(Number(m.create_time) * 1000)
          .toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
      : "";

    return { sender: senderName, time, text };
  });
}

/** Format group messages into a context string. */
export function formatGroupContext(messages: GroupChatMessage[]): string {
  if (messages.length === 0) return "";
  const lines = messages.map(
    (m) => `[${m.sender} ${m.time}] ${m.text}`,
  );
  return lines.join("\n");
}

/** Update an existing interactive card message. */
export async function patchCard(
  client: LarkClient,
  messageId: string,
  markdown: string,
): Promise<void> {
  await client.im.message.patch({
    path: { message_id: messageId },
    data: { content: buildMarkdownCard(markdown) },
  });
}
