import * as lark from "@larksuiteoapi/node-sdk";

type LarkConfig = {
  appId: string;
  appSecret: string;
};

let _client: lark.Client | null = null;

export function getLarkClient(config: LarkConfig): lark.Client {
  if (!_client) {
    _client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
    });
  }
  return _client;
}

export type NotificationCardParams = {
  title: string;
  severity: string;
  body: string;
  linkUrl?: string;
  linkLabel?: string;
};

export function buildNotificationCard(params: NotificationCardParams) {
  const elements: any[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: params.body },
    },
  ];

  if (params.linkUrl) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: params.linkLabel ?? "查看详情" },
          url: params.linkUrl,
          type: "primary",
        },
      ],
    });
  }

  const templateColor =
    params.severity === "P0" || params.severity === "P1" ? "red" : "orange";

  return {
    header: {
      title: { tag: "plain_text", content: `${params.severity} ${params.title}` },
      template: templateColor,
    },
    elements,
  };
}

export async function sendLarkCard(
  client: lark.Client,
  chatId: string,
  card: ReturnType<typeof buildNotificationCard>,
): Promise<string | null> {
  try {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          ...card,
        }),
      },
    });
    return res.data?.message_id ?? null;
  } catch (err) {
    console.error("[lark] Failed to send card:", err);
    return null;
  }
}
