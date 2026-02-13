import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatEvent } from "../../src/chat/types.js";

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
      { type: "done", sessionId: expect.any(String), costUsd: 0 },
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
      { type: "done", sessionId: expect.any(String), costUsd: 0 },
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should handle API errors", async () => {
    const { GenericProvider } = await import(
      "../../src/chat/generic-provider.js"
    );

    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });

    const provider = new GenericProvider({
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      model: "test-model",
    });

    const events: ChatEvent[] = [];
    for await (const event of provider.stream({ message: "hi" })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "error", message: "API error: 429" });
    expect(events[1].type).toBe("done");
  });
});
