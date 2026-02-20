import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "../helpers.js";
import { EventLog } from "../../src/core/event-bus.js";
import { registerWebhookRoutes } from "../../src/routes/webhooks.js";
import type Database from "better-sqlite3";

function setup() {
  const db = createTestDb();
  const eventLog = new EventLog(db);
  const runFaultHealing = vi.fn().mockResolvedValue({ text: "done" });
  const app = new Hono();
  registerWebhookRoutes(app, { db, eventLog, runFaultHealing });
  return { app, db, eventLog, runFaultHealing };
}

const validPayload = {
  action: "created",
  data: {
    issue: {
      id: "12345",
      title: "TypeError: Cannot read property 'name' of null",
      level: "error",
    },
    event: { event_id: "evt-aaa" },
  },
};

describe("POST /webhooks/sentry", () => {
  it("creates a task from a valid Sentry alert", async () => {
    const { app } = setup();

    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBeDefined();
    expect(body.status).toBe("accepted");
  });

  it("deduplicates same issue", async () => {
    // Use a never-resolving mock so the task stays "running" during the test
    const db = createTestDb();
    const eventLog = new EventLog(db);
    const runFaultHealing = vi.fn().mockReturnValue(new Promise(() => {}));
    const app = new Hono();
    registerWebhookRoutes(app, { db, eventLog, runFaultHealing });

    const payload = JSON.stringify({
      action: "created",
      data: {
        issue: { id: "99999", title: "Dup error", level: "error" },
        event: { event_id: "evt-bbb" },
      },
    });

    await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("duplicate");
  });

  it("rejects invalid payload", async () => {
    const { app } = setup();

    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bad: "data" }),
    });

    expect(res.status).toBe(400);
  });

  it("calls agent runner fire-and-forget", async () => {
    const { app, runFaultHealing } = setup();

    await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayload),
    });

    expect(runFaultHealing).toHaveBeenCalledOnce();
    expect(runFaultHealing.mock.calls[0][0]).toContain("12345");
  });

  it("logs event to EventLog", async () => {
    const { app, db } = setup();

    await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayload),
    });

    const row = db
      .prepare("SELECT * FROM event_log WHERE type = 'sentry.issue_alert'")
      .get() as any;
    expect(row).toBeTruthy();
    expect(JSON.parse(row.payload).issueId).toBe("12345");
  });
});
