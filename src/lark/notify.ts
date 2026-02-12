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

export type DiagnosisCardParams = {
  taskId: string;
  title: string;
  severity: string;
  rootCause: string;
  confidence: string;
  impact: string;
};

export function buildDiagnosisCard(params: DiagnosisCardParams) {
  return {
    header: {
      title: {
        tag: "plain_text",
        content: `🔴 ${params.severity} 故障告警`,
      },
      template: "red",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: `**错误:** ${params.title}` },
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: `**根因:** ${params.rootCause}` },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**置信度:** ${params.confidence} | **影响:** ${params.impact}`,
        },
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔧 生成修复" },
            type: "primary",
            value: { action: "fix", taskId: params.taskId },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "👀 查看详情" },
            value: { action: "view", taskId: params.taskId },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🚫 忽略" },
            type: "danger",
            value: { action: "ignore", taskId: params.taskId },
          },
        ],
      },
    ],
  };
}

export type PrReadyCardParams = {
  taskId: string;
  prUrl: string;
  prNumber: number;
  filesChanged: number;
  linesAdded: number;
  testsPassed: number;
  testsFailed: number;
};

export function buildPrReadyCard(params: PrReadyCardParams) {
  return {
    header: {
      title: {
        tag: "plain_text",
        content: "✅ 修复 PR 已就绪",
      },
      template: "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**PR #${params.prNumber}** | 改动: ${params.filesChanged}文件 +${params.linesAdded}行`,
        },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**测试:** ${params.testsPassed}通过 ${params.testsFailed}失败 | **CI:** ${params.testsFailed === 0 ? "✅ 通过" : "❌ 失败"}`,
        },
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ 合并 PR" },
            type: "primary",
            value: { action: "merge", taskId: params.taskId },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "📝 查看代码" },
            url: params.prUrl,
            type: "default",
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔄 要求修改" },
            value: { action: "reject", taskId: params.taskId },
          },
        ],
      },
    ],
  };
}

export async function sendLarkCard(
  client: lark.Client,
  chatId: string,
  card: ReturnType<typeof buildDiagnosisCard | typeof buildPrReadyCard>,
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
