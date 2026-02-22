import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { z } from "zod";
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type { EventLog } from "../core/event-bus.js";
import { createHubEvent } from "../core/hub-event.js";

type AgentRunner = (prompt: string) => Promise<{ text: string; error?: string }>;

type WebhookDeps = {
  db: Database.Database;
  eventLog: EventLog;
  runFaultHealing: AgentRunner;
  sentryWebhookSecret?: string;
};

const sentryPayloadSchema = z.object({
  action: z.string(),
  data: z.object({
    issue: z.object({
      id: z.string(),
      title: z.string(),
      level: z.string(),
    }),
    event: z.object({ event_id: z.string() }).optional(),
  }),
});

function mapSeverity(level: string): string {
  switch (level) {
    case "fatal": return "P0";
    case "error": return "P1";
    case "warning": return "P2";
    default: return "P3";
  }
}

function verifySentrySignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function registerWebhookRoutes(app: Hono, deps: WebhookDeps): void {
  const { db, eventLog, runFaultHealing, sentryWebhookSecret } = deps;

  app.post("/webhooks/sentry", async (c) => {
    // Always read raw body first (needed for both signature check and parsing)
    const rawBody = await c.req.text();

    // HMAC signature verification (if secret configured)
    if (sentryWebhookSecret) {
      const signature = c.req.header("sentry-hook-signature") ?? "";
      if (!verifySentrySignature(rawBody, signature, sentryWebhookSecret)) {
        return c.json({ error: "Invalid signature" }, 401);
      }
    }

    let json: unknown;
    try { json = JSON.parse(rawBody); } catch { return c.json({ error: "Invalid JSON" }, 400); }

    const parsed = sentryPayloadSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "Invalid payload" }, 400);

    const { data } = parsed.data;
    const issueId = data.issue.id;

    // Dedup: skip if a running task already exists for this issue
    const existing = db
      .prepare("SELECT id FROM tasks WHERE sentry_issue_id = ? AND status = 'running' LIMIT 1")
      .get(issueId) as { id: string } | undefined;
    if (existing) {
      return c.json({ status: "duplicate", taskId: existing.id });
    }

    // Create minimal task record
    const taskId = randomUUID();
    const severity = mapSeverity(data.issue.level);
    db.prepare(
      "INSERT INTO tasks (id, sentry_issue_id, title, severity, status) VALUES (?, ?, ?, ?, 'running')",
    ).run(taskId, issueId, data.issue.title, severity);

    // Audit log
    eventLog.log(createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issueId, title: data.issue.title, severity, taskId },
    }));

    // Fire-and-forget: agent handles everything
    const prompt = `Sentry issue #${issueId}: "${data.issue.title}" (${severity}).
Analyze and fix this issue. Use sentry_query, read source code, create a fix, run tests, and submit a PR.`;

    runFaultHealing(prompt)
      .then((result) => {
        const status = result.error ? "failed" : "done";
        const error = result.error ?? null;
        db.prepare("UPDATE tasks SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
          .run(status, error, taskId);
      })
      .catch((err) => {
        console.error(`[fault-healing] Agent failed for task ${taskId}:`, err);
        db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
          .run(String(err), taskId);
      });

    return c.json({ status: "accepted", taskId });
  });
}
