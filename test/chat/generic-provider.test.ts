import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatEvent } from "../../src/chat/types.js";
import { estimateTokens } from "../../src/chat/generic-provider.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function sseResponse(body: string) {
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

describe("estimateTokens", () => {
  it("estimates ASCII text at ~4 chars per token", () => {
    const messages = [{ role: "user" as const, content: "a".repeat(400) }];
    const tokens = estimateTokens(messages);
    expect(tokens).toBe(100); // 400 / 4
  });

  it("estimates CJK text at ~1 char per token", () => {
    const messages = [{ role: "user" as const, content: "你好世界测试一下" }];
    const tokens = estimateTokens(messages);
    expect(tokens).toBe(8);
  });

  it("handles mixed content", () => {
    const messages = [{ role: "user" as const, content: "hello你好" }];
    const tokens = estimateTokens(messages);
    // "hello" = 5 chars * 0.25 = 1.25, "你好" = 2 tokens → ceil(3.25) = 4
    expect(tokens).toBeGreaterThanOrEqual(3);
    expect(tokens).toBeLessThanOrEqual(5);
  });
});

describe("GenericProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should stream text from a simple response", async () => {
    const { GenericProvider } = await import(
      "../../src/chat/generic-provider.js"
    );

    const sseBody = [
      `data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":" world"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    mockFetch.mockResolvedValueOnce(sseResponse(sseBody));

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
      { type: "done", sessionId: "", costUsd: 0 },
    ]);
  });

  it("should handle tool calls and re-invoke LLM", async () => {
    const { GenericProvider } = await import(
      "../../src/chat/generic-provider.js"
    );

    const call1Body = [
      `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_time","arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    const call2Body = [
      `data: {"choices":[{"delta":{"role":"assistant","content":"It is 3pm"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    mockFetch
      .mockResolvedValueOnce(sseResponse(call1Body))
      .mockResolvedValueOnce(sseResponse(call2Body));

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
      { type: "done", sessionId: "", costUsd: 0 },
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should truncate large tool results", async () => {
    const { GenericProvider } = await import(
      "../../src/chat/generic-provider.js"
    );

    const largeOutput = "x".repeat(5000);

    const call1Body = [
      `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"big_tool","arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    const call2Body = [
      `data: {"choices":[{"delta":{"role":"assistant","content":"Done"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    mockFetch
      .mockResolvedValueOnce(sseResponse(call1Body))
      .mockResolvedValueOnce(sseResponse(call2Body));

    const provider = new GenericProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      maxToolResultChars: 100,
      tools: [
        {
          name: "big_tool",
          description: "Returns large output",
          parameters: { type: "object", properties: {} },
          handler: async () => largeOutput,
        },
      ],
    });

    const events: ChatEvent[] = [];
    for await (const event of provider.stream({ message: "go" })) {
      events.push(event);
    }

    const toolResult = events.find((e) => e.type === "tool_result") as any;
    expect(toolResult).toBeTruthy();
    // Result should be truncated to ~100 chars + notice
    expect(toolResult.output.length).toBeLessThan(200);
    expect(toolResult.output).toContain("[...truncated, 5000 chars total]");
  });

  it("should trigger early compaction when token budget exceeded", async () => {
    const { GenericProvider } = await import(
      "../../src/chat/generic-provider.js"
    );

    // Tool returns result that puts us over 80% of a tiny budget
    const toolResult = "data ".repeat(200); // ~1000 chars ≈ 250 tokens

    const call1Body = [
      `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","function":{"name":"big_tool","arguments":""}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    // This would be the final summary turn (no tools)
    const summaryBody = [
      `data: {"choices":[{"delta":{"role":"assistant","content":"Summary"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");

    mockFetch
      .mockResolvedValueOnce(sseResponse(call1Body))
      .mockResolvedValueOnce(sseResponse(summaryBody));

    const provider = new GenericProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
      maxContextTokens: 100, // Very small budget — will trigger compaction after first tool call
      tools: [
        {
          name: "big_tool",
          description: "Returns data",
          parameters: { type: "object", properties: {} },
          handler: async () => toolResult,
        },
      ],
    });

    const events: ChatEvent[] = [];
    for await (const event of provider.stream({ message: "go" })) {
      events.push(event);
    }

    // Should have: tool_use, tool_result, summary text, done
    expect(events.some((e) => e.type === "tool_use")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events[events.length - 1].type).toBe("done");

    // Second fetch should be the final summary turn (triggered by token budget)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The summary turn should NOT include tools in the request body
    const summaryCall = mockFetch.mock.calls[1];
    const summaryReqBody = JSON.parse(summaryCall[1].body);
    expect(summaryReqBody.tools).toBeUndefined();
  });

  it("should handle API errors", async () => {
    const { GenericProvider } = await import(
      "../../src/chat/generic-provider.js"
    );

    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, text: async () => "rate limited" });

    const provider = new GenericProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
    });

    const events: ChatEvent[] = [];
    for await (const event of provider.stream({ message: "hi" })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "error", message: "API 请求频率超限，请稍后再试。" });
    expect(events[1].type).toBe("done");
  });
});
