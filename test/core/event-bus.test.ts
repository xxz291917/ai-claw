import { describe, it, expect } from "vitest";
import { EventLog } from "../../src/core/event-bus.js";
import { createHubEvent } from "../../src/core/hub-event.js";
import { createTestDb } from "../helpers.js";

describe("EventLog", () => {
  it("persists events to event_log table", () => {
    const db = createTestDb();
    const log = new EventLog(db);

    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issue_id: "42" },
      context: { userId: "u1" },
    });
    log.log(event);

    const row = db.prepare("SELECT * FROM event_log WHERE id = ?").get(event.id) as any;
    expect(row).toBeTruthy();
    expect(row.type).toBe("sentry.issue_alert");
    expect(row.source).toBe("sentry");
    expect(JSON.parse(row.payload)).toEqual({ issue_id: "42" });
    expect(JSON.parse(row.context)).toEqual({ userId: "u1" });
  });

  it("stores null context when not provided", () => {
    const db = createTestDb();
    const log = new EventLog(db);

    const event = createHubEvent({
      type: "chat.web",
      source: "web",
      payload: { msg: "hi" },
    });
    log.log(event);

    const row = db.prepare("SELECT * FROM event_log WHERE id = ?").get(event.id) as any;
    expect(row.context).toBeNull();
  });
});
