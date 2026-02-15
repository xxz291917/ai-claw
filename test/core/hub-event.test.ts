import { describe, it, expect } from "vitest";
import { createHubEvent } from "../../src/core/hub-event.js";

describe("createHubEvent", () => {
  it("creates event with id, type, source, and metadata", () => {
    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issue_id: "123" },
    });

    expect(event.id).toBeTruthy();
    expect(event.type).toBe("sentry.issue_alert");
    expect(event.source).toBe("sentry");
    expect(event.payload).toEqual({ issue_id: "123" });
    expect(event.metadata.receivedAt).toBeTruthy();
  });

  it("includes optional context", () => {
    const event = createHubEvent({
      type: "chat.web",
      source: "web_chat",
      payload: { message: "hello" },
      context: { userId: "u1", sessionId: "s1" },
    });

    expect(event.context?.userId).toBe("u1");
    expect(event.context?.sessionId).toBe("s1");
  });
});
