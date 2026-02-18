import type { ChatProvider, ChatEvent, ChatRequest } from "./types.js";

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: any) => Promise<string>;
};

export type GenericProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
  tools?: ToolDef[];
  maxTurns?: number;
  /** Max characters per tool result (default 4000). Longer results are truncated. */
  maxToolResultChars?: number;
  /** Approximate max context tokens before triggering early compaction (default 60000). */
  maxContextTokens?: number;
};

type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export class GenericProvider implements ChatProvider {
  readonly name: string;
  private maxToolResultChars: number;
  private maxContextTokens: number;

  constructor(private config: GenericProviderConfig) {
    this.name = config.model;
    this.maxToolResultChars = config.maxToolResultChars ?? 4000;
    this.maxContextTokens = config.maxContextTokens ?? 60_000;
  }

  async summarize(
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: "system",
            content:
              "Summarize the following conversation concisely in the same language. Preserve key facts, decisions, and context.",
          },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        max_tokens: 500,
      }),
    });
    if (!res.ok) throw new Error(`Summarize API error: ${res.status}`);
    const data: any = await res.json();
    return data.choices?.[0]?.message?.content ?? "[Summary unavailable]";
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const maxTurns = this.config.maxTurns ?? 10;

    const messages: Message[] = [];
    if (this.config.systemPrompt) {
      messages.push({ role: "system", content: this.config.systemPrompt });
    }
    if (req.history) {
      for (const h of req.history) {
        messages.push({ role: h.role, content: h.content });
      }
    }
    messages.push({ role: "user", content: req.message });

    const toolMap = new Map(
      (this.config.tools ?? []).map((t) => [t.name, t]),
    );

    const openaiTools =
      this.config.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })) ?? [];

    for (let turn = 0; turn < maxTurns; turn++) {
      const body: Record<string, unknown> = {
        model: this.config.model,
        messages,
        stream: true,
      };
      if (openaiTools.length > 0) {
        body.tools = openaiTools;
      }

      let res: Response;
      try {
        res = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err: any) {
        yield { type: "error", message: `Network error: ${err.message}` };
        yield { type: "done", sessionId: "", costUsd: 0 };
        return;
      }

      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => "");
        console.error(`[chat] API error ${res.status}:`, errBody);
        yield { type: "error", message: friendlyApiError(res.status, errBody) };
        yield { type: "done", sessionId: "", costUsd: 0 };
        return;
      }

      let assistantContent = "";
      const toolCalls: ToolCall[] = [];
      const toolCallArgs: Map<number, string> = new Map();

      for await (const line of readSSELines(res.body)) {
        if (line === "[DONE]") break;

        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }

        const delta = data.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          assistantContent += delta.content;
          yield { type: "text", content: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (tc.id) {
              toolCalls[idx] = {
                id: tc.id,
                type: "function",
                function: { name: tc.function?.name ?? "", arguments: "" },
              };
            }
            if (tc.function?.arguments) {
              const prev = toolCallArgs.get(idx) ?? "";
              toolCallArgs.set(idx, prev + tc.function.arguments);
            }
            if (tc.function?.name && toolCalls[idx]) {
              toolCalls[idx].function.name = tc.function.name;
            }
          }
        }
      }

      for (const [idx, args] of toolCallArgs) {
        if (toolCalls[idx]) {
          toolCalls[idx].function.arguments = args;
        }
      }

      if (toolCalls.length === 0) {
        yield { type: "done", sessionId: "", costUsd: 0 };
        return;
      }

      messages.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: toolCalls.filter(Boolean),
      });

      for (const tc of toolCalls) {
        if (!tc) continue;
        let args: any;
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }

        yield { type: "tool_use", tool: tc.function.name, input: args };

        const handler = toolMap.get(tc.function.name);
        let result: string;
        if (handler) {
          try {
            result = await handler.handler(args);
          } catch (err: any) {
            result = `Error: ${err.message}`;
          }
        } else {
          result = `Unknown tool: ${tc.function.name}`;
        }

        // Truncate large tool results
        result = truncateToolResult(result, this.maxToolResultChars);

        yield { type: "tool_result", tool: tc.function.name, output: result };
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }

      // Token budget check — if approaching limit, compact tool results and finish
      const usedTokens = estimateTokens(messages);
      if (usedTokens > this.maxContextTokens * 0.8) {
        console.log(
          `[chat] Token budget ~${usedTokens}/${this.maxContextTokens} (${Math.round((usedTokens / this.maxContextTokens) * 100)}%) — compacting and finishing`,
        );
        compactToolMessages(messages, this.maxToolResultChars);
        yield* this.finalSummaryTurn(messages);
        return;
      }
    }

    // Tool-call budget exhausted — make one final call WITHOUT tools
    // so the LLM summarises what it accomplished instead of a hard error.
    yield* this.finalSummaryTurn(messages);
  }

  /**
   * One last LLM call with no tools, forcing a text-only wrap-up.
   */
  private async *finalSummaryTurn(
    messages: Message[],
  ): AsyncGenerator<ChatEvent> {
    messages.push({
      role: "system",
      content:
        "You have used all available tool calls. " +
        "Do NOT call any more tools. " +
        "Summarise what you have accomplished so far and let the user know if anything remains incomplete. " +
        "Reply in the same language the user used.",
    });

    try {
      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: true,
          // Intentionally omit `tools` so the model cannot call any
        }),
      });

      if (!res.ok || !res.body) {
        yield { type: "done", sessionId: "", costUsd: 0 };
        return;
      }

      for await (const line of readSSELines(res.body)) {
        if (line === "[DONE]") break;
        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }
        const content = data.choices?.[0]?.delta?.content;
        if (content) {
          yield { type: "text", content };
        }
      }
    } catch {
      // Network failure on wrap-up — silently finish
    }

    yield { type: "done", sessionId: "", costUsd: 0 };
  }
}

/**
 * Truncate a tool result to maxChars, appending a notice if truncated.
 */
function truncateToolResult(result: string, maxChars: number): string {
  if (result.length <= maxChars) return result;
  return (
    result.slice(0, maxChars) +
    `\n\n[...truncated, ${result.length} chars total]`
  );
}

/**
 * Estimate token count for a messages array.
 * Rough heuristic: CJK chars ≈ 1 token each, other chars ≈ 1 token per 4 chars.
 * Good enough for budget tracking — not meant for billing precision.
 */
export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    const text =
      m.role === "assistant"
        ? (m as any).content ?? ""
        : (m as any).content ?? "";
    total += estimateStringTokens(text);
    // Account for tool_calls arguments in assistant messages
    if (m.role === "assistant" && (m as any).tool_calls) {
      for (const tc of (m as any).tool_calls) {
        total += estimateStringTokens(tc.function?.arguments ?? "");
        total += estimateStringTokens(tc.function?.name ?? "");
      }
    }
  }
  return total;
}

function estimateStringTokens(s: string): number {
  let tokens = 0;
  for (const ch of s) {
    // CJK Unified Ideographs + common CJK ranges
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Punctuation
      (code >= 0xff00 && code <= 0xffef)    // Fullwidth Forms
    ) {
      tokens += 1;
    } else {
      tokens += 0.25; // ~4 ASCII chars per token
    }
  }
  return Math.ceil(tokens);
}

/**
 * Compact older tool messages to free up context space.
 * Keeps the last 2 tool results intact, aggressively truncates earlier ones.
 */
function compactToolMessages(messages: Message[], keepChars: number): void {
  const compactLimit = Math.min(keepChars, 500);
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIndices.push(i);
  }
  // Keep last 2 tool results full, compact the rest
  const toCompact = toolIndices.slice(0, -2);
  for (const idx of toCompact) {
    const msg = messages[idx] as { role: "tool"; tool_call_id: string; content: string };
    if (msg.content.length > compactLimit) {
      msg.content =
        msg.content.slice(0, compactLimit) +
        `\n[...compacted, ${msg.content.length} chars original]`;
    }
  }
}

function friendlyApiError(status: number, body: string): string {
  // Try to extract the API's error message
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message ?? parsed?.message;
    if (msg) {
      // Known patterns from DeepSeek / OpenAI-compatible APIs
      if (/content.*risk/i.test(msg)) {
        return "内容被 API 安全过滤器拦截，请换一种方式提问。";
      }
      if (/rate.?limit/i.test(msg)) {
        return "API 请求频率超限，请稍后再试。";
      }
      if (/quota|balance|insufficient/i.test(msg)) {
        return "API 额度不足，请联系管理员。";
      }
      if (/context.?length|too.?long|token/i.test(msg)) {
        return "对话过长，请使用 /reset 重置会话后重试。";
      }
      return `API 返回错误: ${msg}`;
    }
  } catch {
    // body is not JSON — fall through
  }

  // Fallback by HTTP status
  if (status === 401) return "API 认证失败，请检查 API Key 配置。";
  if (status === 429) return "API 请求频率超限，请稍后再试。";
  if (status >= 500) return `API 服务暂时不可用 (${status})，请稍后再试。`;
  return `API 请求失败 (${status})`;
}

async function* readSSELines(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          yield trimmed.slice(6);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
