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
