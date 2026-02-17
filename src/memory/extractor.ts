import type { ExtractedMemory, MemoryCategory } from "./types.js";

type HistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type LlmCallFn = (prompt: string) => Promise<string>;

const VALID_CATEGORIES = new Set<MemoryCategory>([
  "preference",
  "decision",
  "fact",
  "todo",
]);

const EXTRACTION_PROMPT = `从以下对话中提取值得长期记住的信息。只提取明确的事实，不要推测。
分类: preference(用户偏好), decision(技术决策), fact(项目事实), todo(待办事项)
返回 JSON 数组: [{"category": "...", "key": "简短标题", "value": "具体内容"}]
如果没有值得记住的信息，返回空数组 []。

对话内容:
`;

export async function extractMemories(
  messages: HistoryMessage[],
  callLlm: LlmCallFn,
): Promise<ExtractedMemory[]> {
  try {
    const conversation = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const raw = await callLlm(EXTRACTION_PROMPT + conversation);
    return parseExtraction(raw);
  } catch {
    return [];
  }
}

function parseExtraction(raw: string): ExtractedMemory[] {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (item: any) =>
      item &&
      typeof item.category === "string" &&
      VALID_CATEGORIES.has(item.category) &&
      typeof item.key === "string" &&
      item.key.length > 0 &&
      typeof item.value === "string" &&
      item.value.length > 0,
  ) as ExtractedMemory[];
}
