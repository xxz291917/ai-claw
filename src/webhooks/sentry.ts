import type { Hono } from "hono";
import { z } from "zod";
import type { TaskStore } from "../tasks/store.js";

const sentryPayloadSchema = z.object({
  action: z.string(),
  data: z.object({
    issue: z.object({
      id: z.string(),
      title: z.string(),
      level: z.string(),
    }),
    event: z
      .object({
        event_id: z.string(),
      })
      .optional(),
  }),
});

export function sentryWebhook(
  app: Hono,
  store: TaskStore,
  onTaskCreated?: (taskId: string) => void,
): void {
  app.post("/webhooks/sentry", async (c) => {
    const parseResult = sentryPayloadSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: "Invalid payload" }, 400);
    }

    const { data } = parseResult.data;
    const issueId = data.issue.id;

    // Dedup: skip if an active task already exists for this issue
    const existing = store.findByIssueId(issueId);
    if (
      existing &&
      !["done", "failed", "ignored", "rejected"].includes(existing.state)
    ) {
      return c.json({ status: "duplicate", taskId: existing.id });
    }

    const task = store.create({
      sentryIssueId: issueId,
      sentryEventId: data.event?.event_id ?? "",
      title: data.issue.title,
      severity: mapSeverity(data.issue.level),
    });

    onTaskCreated?.(task.id);

    return c.json({ status: "accepted", taskId: task.id });
  });
}

function mapSeverity(level: string): string {
  switch (level) {
    case "fatal":
      return "P0";
    case "error":
      return "P1";
    case "warning":
      return "P2";
    default:
      return "P3";
  }
}
