// test/core/event-bus.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../src/core/event-bus.js";
import { createHubEvent } from "../../src/core/hub-event.js";
import { createTestDb } from "../helpers.js";

describe("EventBus", () => {
  it("calls handler when event is emitted", async () => {
    const db = createTestDb();
    const bus = new EventBus(db);
    const handler = vi.fn();

    bus.on("sentry.*", handler);

    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issue_id: "1" },
    });
    await bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("wildcard * matches all events", async () => {
    const db = createTestDb();
    const bus = new EventBus(db);
    const handler = vi.fn();

    bus.on("*", handler);

    await bus.emit(
      createHubEvent({ type: "sentry.issue_alert", source: "sentry", payload: {} }),
    );
    await bus.emit(
      createHubEvent({ type: "chat.web", source: "web_chat", payload: {} }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not call handler for non-matching pattern", async () => {
    const db = createTestDb();
    const bus = new EventBus(db);
    const handler = vi.fn();

    bus.on("notion.*", handler);

    await bus.emit(
      createHubEvent({ type: "sentry.issue_alert", source: "sentry", payload: {} }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("persists events to event_log table", async () => {
    const db = createTestDb();
    const bus = new EventBus(db);

    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issue_id: "42" },
      context: { userId: "u1" },
    });
    await bus.emit(event);

    const row = db.prepare("SELECT * FROM event_log WHERE id = ?").get(event.id) as any;
    expect(row).toBeTruthy();
    expect(row.type).toBe("sentry.issue_alert");
    expect(row.source).toBe("sentry");
    expect(JSON.parse(row.payload)).toEqual({ issue_id: "42" });
    expect(JSON.parse(row.context)).toEqual({ userId: "u1" });
  });
});
