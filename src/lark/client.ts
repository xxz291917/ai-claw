import * as lark from "@larksuiteoapi/node-sdk";

export type LarkClient = lark.Client;

export type LarkConfig = {
  appId: string;
  appSecret: string;
  verificationToken?: string;
};

export function createLarkClient(config: LarkConfig): LarkClient {
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
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

/** Fetch the bot's own open_id via Lark API. */
export async function fetchBotOpenId(client: LarkClient): Promise<string> {
  const res: any = await client.request({
    url: "/open-apis/bot/v3/info",
    method: "GET",
  });
  const openId = res?.bot?.open_id;
  if (!openId) throw new Error(`Failed to fetch bot open_id from Lark API: ${JSON.stringify(res)}`);
  return openId;
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
