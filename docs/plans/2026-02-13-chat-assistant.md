# Chat Assistant Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a multi-turn web chat assistant that supports Claude Agent SDK and generic OpenAI-compatible models with tool calling.

**Architecture:** Define a `ChatProvider` interface that abstracts streaming chat. `ClaudeProvider` wraps the Agent SDK's `query()` with `resume` for multi-turn. `GenericProvider` implements a self-built agentic loop for OpenAI-compatible APIs (Kimi, DeepSeek, etc.). A Hono SSE endpoint streams events to a single-file web chat UI.

**Tech Stack:** Claude Agent SDK (streaming + resume), OpenAI-compatible chat completions API, Hono SSE, vanilla HTML/CSS/JS frontend

---

### Task 1: ChatProvider Types

**Files:**
- Create: `src/chat/types.ts`

**Step 1: Create the type definitions**

```typescript
/**
 * Provider-agnostic chat interface.
 * ClaudeProvider uses Agent SDK; GenericProvider uses OpenAI-compatible API.
 */

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; costUsd: number };

export type ChatRequest = {
  message: string;
  sessionId?: string;
};

export interface ChatProvider {
  readonly name: string;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
}
```

**Step 2: Commit**

```bash
git add src/chat/types.ts
git commit -m "feat(chat): add ChatProvider interface and event types"
```

---

### Task 2: ClaudeProvider

**Files:**
- Create: `src/chat/claude-provider.ts`
- Test: `test/chat/claude-provider.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";

// We can't easily mock the SDK's query(), so test the config building logic
describe("ClaudeProvider", () => {
  it("should have name 'claude'", async () => {
    // Dynamically import to avoid SDK side effects
    const { ClaudeProvider } = await import("../../src/chat/claude-provider.js");
    const provider = new ClaudeProvider({
      workspaceDir: "/tmp/test",
      skillContent: "You are a helpful assistant.",
    });
    expect(provider.name).toBe("claude");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/claude-provider.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatProvider, ChatEvent, ChatRequest } from "./types.js";

export type ClaudeProviderConfig = {
  workspaceDir: string;
  skillContent: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
  mcpServers?: Record<string, unknown>;
};

export class ClaudeProvider implements ChatProvider {
  readonly name = "claude";

  constructor(private config: ClaudeProviderConfig) {}

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const abortController = new AbortController();

    const q = query({
      prompt: req.message,
      options: {
        cwd: this.config.workspaceDir,
        systemPrompt: this.config.skillContent,
        tools: { type: "preset", preset: "claude_code" },
        mcpServers: this.config.mcpServers as any,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: this.config.maxTurns ?? 30,
        maxBudgetUsd: this.config.maxBudgetUsd ?? 2.0,
        includePartialMessages: true,
        persistSession: true,
        ...(req.sessionId ? { resume: req.sessionId } : {}),
        abortController,
        env: {
          ...process.env,
          ...(this.config.env ?? {}),
        },
      },
    });

    try {
      for await (const message of q) {
        if (message.type === "stream_event") {
          const event = (message as any).event;
          if (event?.type === "content_block_delta" && event.delta?.text) {
            yield { type: "text", content: event.delta.text };
          }
        } else if (message.type === "tool_progress") {
          const msg = message as any;
          yield {
            type: "tool_use",
            tool: msg.tool_name ?? "unknown",
            input: { elapsed: msg.elapsed_time_seconds },
          };
        } else if (message.type === "result") {
          const msg = message as any;
          if (msg.subtype === "success") {
            yield {
              type: "done",
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd ?? 0,
            };
          } else {
            yield {
              type: "error",
              message: msg.errors?.join("; ") ?? "Agent run failed",
            };
            yield {
              type: "done",
              sessionId: msg.session_id ?? "",
              costUsd: msg.total_cost_usd ?? 0,
            };
          }
        }
      }
    } catch (err: any) {
      yield { type: "error", message: err.message ?? "Unknown error" };
      yield { type: "done", sessionId: "", costUsd: 0 };
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat/claude-provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/chat/claude-provider.ts test/chat/claude-provider.test.ts
git commit -m "feat(chat): add ClaudeProvider wrapping Agent SDK streaming"
```

---

### Task 3: GenericProvider (OpenAI-compatible agentic loop)

**Files:**
- Create: `src/chat/generic-provider.ts`
- Test: `test/chat/generic-provider.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatEvent } from "../../src/chat/types.js";

// Mock fetch for OpenAI-compatible API
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("GenericProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should stream text from a simple response", async () => {
    const { GenericProvider } = await import(
      "../../src/chat/generic-provider.js"
    );

    // Mock SSE response: a simple text reply with no tool calls
    const sseBody = [
      `data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":" world"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseBody));
          controller.close();
        },
      }),
    });

    const provider = new GenericProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
    });

    const events: ChatEvent[] = [];
    for await (const event of provider.stream({ message: "hi" })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text", content: "Hello" },
      { type: "text", content: " world" },
      { type: "done", sessionId: expect.any(String), costUsd: 0 },
    ]);
  });

  it("should handle tool calls and re-invoke LLM", async () => {
    const { GenericProvider } = await import(
      "../../src/chat/generic-provider.js"
    );

    // First call: LLM returns a tool call
    const call1Body = [
      `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_time","arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    // Second call: LLM returns text after tool result
    const call2Body = [
      `data: {"choices":[{"delta":{"role":"assistant","content":"It is 3pm"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(call1Body));
            controller.close();
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(call2Body));
            controller.close();
          },
        }),
      });

    const provider = new GenericProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      tools: [
        {
          name: "get_time",
          description: "Get current time",
          parameters: { type: "object", properties: {} },
          handler: async () => "15:00",
        },
      ],
    });

    const events: ChatEvent[] = [];
    for await (const event of provider.stream({ message: "what time?" })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "tool_use", tool: "get_time", input: {} },
      { type: "tool_result", tool: "get_time", output: "15:00" },
      { type: "text", content: "It is 3pm" },
      { type: "done", sessionId: expect.any(String), costUsd: 0 },
    ]);

    // Should have made 2 fetch calls (initial + after tool result)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/generic-provider.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
import type { ChatProvider, ChatEvent, ChatRequest } from "./types.js";

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: any) => Promise<string>;
};

export type GenericProviderConfig = {
  baseUrl: string; // e.g. "https://api.deepseek.com/v1"
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
  private sessions = new Map<string, Message[]>();

  constructor(private config: GenericProviderConfig) {
    this.name = config.model;
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const sessionId = req.sessionId ?? crypto.randomUUID();
    const maxTurns = this.config.maxTurns ?? 10;

    // Load or init message history
    let messages = this.sessions.get(sessionId) ?? [];
    if (messages.length === 0 && this.config.systemPrompt) {
      messages.push({ role: "system", content: this.config.systemPrompt });
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

      const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        yield { type: "error", message: `API error: ${res.status}` };
        yield { type: "done", sessionId, costUsd: 0 };
        this.sessions.set(sessionId, messages);
        return;
      }

      // Parse SSE stream
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

        // Text content
        if (delta.content) {
          assistantContent += delta.content;
          yield { type: "text", content: delta.content };
        }

        // Tool calls
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

      // Merge accumulated arguments into tool calls
      for (const [idx, args] of toolCallArgs) {
        if (toolCalls[idx]) {
          toolCalls[idx].function.arguments = args;
        }
      }

      // No tool calls — we're done
      if (toolCalls.length === 0) {
        messages.push({ role: "assistant", content: assistantContent });
        this.sessions.set(sessionId, messages);
        yield { type: "done", sessionId, costUsd: 0 };
        return;
      }

      // Execute tool calls
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

      // Loop continues — LLM will be called again with tool results
    }

    // Max turns reached
    this.sessions.set(sessionId, messages);
    yield { type: "error", message: "Max turns reached" };
    yield { type: "done", sessionId, costUsd: 0 };
  }
}

/**
 * Parse SSE lines from a ReadableStream.
 */
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat/generic-provider.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/chat/generic-provider.ts test/chat/generic-provider.test.ts
git commit -m "feat(chat): add GenericProvider with OpenAI-compatible agentic loop"
```

---

### Task 4: Chat SSE Router

**Files:**
- Create: `src/chat/router.ts`
- Test: `test/chat/router.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { ChatProvider, ChatEvent } from "../../src/chat/types.js";
import { chatRouter } from "../../src/chat/router.js";

function mockProvider(events: ChatEvent[]): ChatProvider {
  return {
    name: "test",
    async *stream() {
      for (const e of events) yield e;
    },
  };
}

describe("chatRouter", () => {
  it("POST /api/chat returns SSE stream", async () => {
    const app = new Hono();
    chatRouter(app, mockProvider([
      { type: "text", content: "Hello" },
      { type: "text", content: " world" },
      { type: "done", sessionId: "s1", costUsd: 0.01 },
    ]));

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain(`data: {"type":"text","content":"Hello"}`);
    expect(text).toContain(`data: {"type":"text","content":" world"}`);
    expect(text).toContain(`data: {"type":"done"`);
  });

  it("returns 400 if message is missing", async () => {
    const app = new Hono();
    chatRouter(app, mockProvider([]));

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/router.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ChatProvider } from "./types.js";

export function chatRouter(app: Hono, provider: ChatProvider): void {
  app.post("/api/chat", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const message = body.message;
    const sessionId = body.sessionId;

    if (!message || typeof message !== "string") {
      return c.json({ error: "message is required" }, 400);
    }

    return streamSSE(c, async (stream) => {
      for await (const event of provider.stream({ message, sessionId })) {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    });
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat/router.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/chat/router.ts test/chat/router.test.ts
git commit -m "feat(chat): add SSE chat router endpoint"
```

---

### Task 5: Web Chat UI

**Files:**
- Create: `src/public/index.html`

**Step 1: Create the chat page**

A single self-contained HTML file with inline CSS and JS. Features:
- Message input with send button
- Streaming text display
- Tool call indicators
- Session persistence in memory (sessionId from done event)
- Auto-scroll, Shift+Enter for newline, Enter to send

```html
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Hub Chat</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f5;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    background: #1a1a2e;
    color: #fff;
    padding: 12px 20px;
    font-size: 16px;
    font-weight: 600;
    flex-shrink: 0;
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .msg {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 14px;
  }
  .msg.user {
    align-self: flex-end;
    background: #1a1a2e;
    color: #fff;
  }
  .msg.assistant {
    align-self: flex-start;
    background: #fff;
    border: 1px solid #e0e0e0;
  }
  .msg .tool-badge {
    display: inline-block;
    background: #e8f4fd;
    color: #0277bd;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    margin: 2px 0;
  }
  .msg .cost {
    font-size: 11px;
    color: #999;
    margin-top: 4px;
  }
  #input-area {
    flex-shrink: 0;
    border-top: 1px solid #e0e0e0;
    background: #fff;
    padding: 12px 20px;
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  #input {
    flex: 1;
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 14px;
    font-family: inherit;
    resize: none;
    max-height: 120px;
    line-height: 1.4;
    outline: none;
  }
  #input:focus { border-color: #1a1a2e; }
  #send {
    background: #1a1a2e;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 10px 20px;
    font-size: 14px;
    cursor: pointer;
    white-space: nowrap;
  }
  #send:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
  <header>AI Hub Chat</header>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" rows="1" placeholder="Ask anything..."></textarea>
    <button id="send">Send</button>
  </div>

<script>
const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
let sessionId = null;
let sending = false;

// Auto-resize textarea
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
});

// Enter to send, Shift+Enter for newline
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

sendBtn.addEventListener("click", send);

async function send() {
  const text = inputEl.value.trim();
  if (!text || sending) return;

  sending = true;
  sendBtn.disabled = true;
  inputEl.value = "";
  inputEl.style.height = "auto";

  // User message
  appendMsg("user", text);

  // Assistant message (streaming)
  const assistantEl = appendMsg("assistant", "");
  let fullText = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, sessionId }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        let event;
        try { event = JSON.parse(trimmed.slice(6)); } catch { continue; }

        if (event.type === "text") {
          fullText += event.content;
          assistantEl.querySelector(".content").textContent = fullText;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (event.type === "tool_use") {
          const badge = document.createElement("span");
          badge.className = "tool-badge";
          badge.textContent = event.tool;
          assistantEl.querySelector(".content").appendChild(badge);
        } else if (event.type === "tool_result") {
          // Tool results are internal, skip display
        } else if (event.type === "error") {
          fullText += "\n[Error: " + event.message + "]";
          assistantEl.querySelector(".content").textContent = fullText;
        } else if (event.type === "done") {
          sessionId = event.sessionId || sessionId;
          if (event.costUsd > 0) {
            const costEl = document.createElement("div");
            costEl.className = "cost";
            costEl.textContent = "$" + event.costUsd.toFixed(4);
            assistantEl.appendChild(costEl);
          }
        }
      }
    }
  } catch (err) {
    assistantEl.querySelector(".content").textContent = "[Connection error]";
  }

  if (!fullText) {
    assistantEl.querySelector(".content").textContent = "[No response]";
  }

  sending = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

function appendMsg(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  const content = document.createElement("span");
  content.className = "content";
  content.textContent = text;
  el.appendChild(content);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}
</script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add src/public/index.html
git commit -m "feat(chat): add web chat UI page"
```

---

### Task 6: Wire Into Server

**Files:**
- Modify: `src/server.ts`
- Modify: `src/env.ts`

**Step 1: Add chat provider config to env**

In `src/env.ts`, add optional chat config fields to the schema:

```typescript
// Add to envSchema:
CHAT_PROVIDER: z.enum(["claude", "generic"]).default("claude"),
CHAT_MODEL: z.string().optional(),           // For generic: model name
CHAT_API_BASE: z.string().optional(),        // For generic: API base URL
CHAT_API_KEY: z.string().optional(),         // For generic: API key
CHAT_SYSTEM_PROMPT: z.string().default("You are a helpful engineering assistant. You have access to code tools (bash, read, write, edit, grep, glob) and can help with any engineering task."),
```

**Step 2: Integrate chat into server.ts**

Add to `src/server.ts`:

```typescript
// Add imports at top:
import { serveStatic } from "@hono/node-server/serve-static";
import { chatRouter } from "./chat/router.js";
import { ClaudeProvider } from "./chat/claude-provider.js";
import { GenericProvider } from "./chat/generic-provider.js";
import type { ChatProvider } from "./chat/types.js";

// Inside createApp(), after the existing route setup, add:

  // --- Chat Assistant ---
  let chatProvider: ChatProvider;
  if (env.CHAT_PROVIDER === "generic" && env.CHAT_API_BASE && env.CHAT_API_KEY) {
    chatProvider = new GenericProvider({
      baseUrl: env.CHAT_API_BASE,
      apiKey: env.CHAT_API_KEY,
      model: env.CHAT_MODEL ?? "deepseek-chat",
      systemPrompt: env.CHAT_SYSTEM_PROMPT,
    });
  } else {
    chatProvider = new ClaudeProvider({
      workspaceDir: env.WORKSPACE_DIR,
      skillContent: env.CHAT_SYSTEM_PROMPT,
      env: { GH_TOKEN: env.GH_TOKEN },
      mcpServers: agentConfig.mcpServers
        ? { "ai-hub-tools": agentConfig.mcpServers }
        : undefined,
    });
  }

  chatRouter(app, chatProvider);

  // Serve static files (chat UI)
  app.use("/*", serveStatic({ root: resolve(__dirname, "public") }));
```

**Step 3: Update .env.example**

Add to `.env.example`:

```bash
# Chat Assistant
# CHAT_PROVIDER=claude              # "claude" or "generic"
# CHAT_MODEL=deepseek-chat          # Model name (for generic provider)
# CHAT_API_BASE=https://api.deepseek.com/v1  # API base URL (for generic)
# CHAT_API_KEY=sk-xxx               # API key (for generic provider)
```

**Step 4: Run full test suite**

Run: `npm test`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/server.ts src/env.ts .env.example
git commit -m "feat(chat): wire chat provider and UI into server"
```

---

### Task 7: Smoke Test

**Step 1: Start dev server and verify chat works**

```bash
npm run dev
```

Open `http://localhost:8080/` in browser. Send a message and verify:
- Streaming text appears incrementally
- Session continues across messages (multi-turn)
- No console errors

**Step 2: Verify existing tests still pass**

```bash
npm test
```

Expected: All tests PASS

**Step 3: Commit any final tweaks if needed**

```bash
git add -A
git commit -m "feat(chat): complete chat assistant integration"
```
