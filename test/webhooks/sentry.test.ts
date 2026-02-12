import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "../helpers.js";
import { TaskStore } from "../../src/tasks/store.js";
import { sentryWebhook } from "../../src/webhooks/sentry.js";
import type Database from "better-sqlite3";

describe("POST /webhooks/sentry", () => {
  let app: Hono;
  let store: TaskStore;
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    app = new Hono();
    sentryWebhook(app, store);
  });

  it("creates a task from a valid Sentry alert", async () => {
    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "created",
        data: {
          issue: {
            id: "12345",
            title: "TypeError: Cannot read property 'name' of null",
            level: "error",
          },
          event: {
            event_id: "evt-aaa",
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBeDefined();
    expect(body.status).toBe("accepted");
  });

  it("deduplicates same issue", async () => {
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
    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bad: "data" }),
    });

    expect(res.status).toBe(400);
  });
});
