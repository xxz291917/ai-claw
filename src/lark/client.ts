import * as lark from "@larksuiteoapi/node-sdk";

export type LarkClient = lark.Client;

export type LarkConfig = {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  /** Pre-configured bot open_id. If set, skips the API call to fetch it. */
  openId?: string;
};

export function createLarkClient(config: LarkConfig): LarkClient {
  return new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Lark,
  });
}

/**
 * Lark cards support at most 3 tables. Convert excess markdown tables
 * to plain-text aligned format so the card doesn't get rejected.
 */
const LARK_TABLE_LIMIT = 3;

function flattenExcessTables(text: string): string {
  let count = 0;
  return text.replace(
    // Match a full markdown table (header + separator + rows)
    /(?:^|\n)(\|[^\n]+\|\n\|[-| :]+\|\n(?:\|[^\n]+\|\n?)*)/g,
    (match) => {
      count++;
      if (count <= LARK_TABLE_LIMIT) return match;
      // Convert table to plain text: strip leading/trailing pipes, align with spaces
      return match.replace(/^\||\|$/gm, "").replace(/\|/g, "  ");
    },
  );
}

/** Build a markdown card JSON for interactive messages. */
export function buildMarkdownCard(text: string): string {
  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: "markdown", content: flattenExcessTables(text) }],
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
