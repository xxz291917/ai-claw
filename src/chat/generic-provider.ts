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
};

type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

export class GenericProvider implements ChatProvider {
  readonly name: string;

  constructor(private config: GenericProviderConfig) {
    this.name = config.model;
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
        yield { type: "error", message: `API error: ${res.status}` };
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

        yield { type: "tool_result", tool: tc.function.name, output: result };
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }

    yield { type: "error", message: "Max turns reached" };
    yield { type: "done", sessionId: "", costUsd: 0 };
  }
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
