import type { ExtractedMemory, MemoryCategory, MemoryItem } from "./types.js";

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
`;

const EXISTING_MEMORY_SECTION = `以下是该用户已有的记忆。如果新信息与已有记忆是同一主题，请复用已有的 key（不要发明新 key）。如果信息有更新，使用相同的 key 和新的 value。
已有记忆:
`;

/** Max existing memories to include in the extraction prompt. */
const MAX_EXISTING_IN_PROMPT = 30;

export async function extractMemories(
  messages: HistoryMessage[],
  callLlm: LlmCallFn,
  existingMemories?: MemoryItem[],
): Promise<ExtractedMemory[]> {
  try {
    const conversation = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    let prompt = EXTRACTION_PROMPT;

    // Inject existing memories so the LLM reuses keys instead of inventing new ones
    if (existingMemories && existingMemories.length > 0) {
      const capped = existingMemories.slice(0, MAX_EXISTING_IN_PROMPT);
      const memoryList = capped
        .map((m) => `- [${m.category}] ${m.key}: ${m.value}`)
        .join("\n");
      prompt += EXISTING_MEMORY_SECTION + memoryList + "\n\n";
    }

    prompt += "对话内容:\n" + conversation;

    const raw = await callLlm(prompt);
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
