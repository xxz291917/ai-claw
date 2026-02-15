import { describe, it, expect } from "vitest";
import { SentryInputAdapter } from "../../../src/adapters/input/sentry.js";

describe("SentryInputAdapter", () => {
  const adapter = new SentryInputAdapter();

  it("converts valid sentry webhook to HubEvent", () => {
    const raw = {
      action: "triggered",
      data: {
        issue: { id: "123", title: "TypeError", level: "error" },
        event: { event_id: "evt-1" },
      },
    };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("sentry.issue_alert");
    expect(event!.source).toBe("sentry");
    expect(event!.payload.issueId).toBe("123");
    expect(event!.payload.title).toBe("TypeError");
    expect(event!.payload.severity).toBe("P1");
    expect(event!.payload.eventId).toBe("evt-1");
  });

  it("returns null for invalid payload", () => {
    const event = adapter.toEvent({ garbage: true });
    expect(event).toBeNull();
  });
});
