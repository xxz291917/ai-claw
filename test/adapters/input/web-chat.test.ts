import { describe, it, expect } from "vitest";
import { WebChatInputAdapter } from "../../../src/adapters/input/web-chat.js";

describe("WebChatInputAdapter", () => {
  const adapter = new WebChatInputAdapter();

  it("converts chat request to HubEvent", () => {
    const raw = { message: "hello", sessionId: "s-1" };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("chat.web");
    expect(event!.source).toBe("web_chat");
    expect(event!.payload.message).toBe("hello");
    expect(event!.context?.sessionId).toBe("s-1");
  });

  it("returns null if message is missing", () => {
    const event = adapter.toEvent({ sessionId: "s-1" });
    expect(event).toBeNull();
  });
});
