import type { Hono } from "hono";
import type { TaskStore } from "../tasks/store.js";
import type { EventBus } from "../core/event-bus.js";
import type { SentryInputAdapter } from "../adapters/input/sentry.js";
import type { LarkInputAdapter } from "../adapters/input/lark.js";

type WebhookRoutesDeps = {
  store: TaskStore;
  eventBus: EventBus;
  sentryAdapter: SentryInputAdapter;
  larkAdapter: LarkInputAdapter;
};

/**
 * Register EventBus-integrated webhook routes.
 *
 * Replaces the legacy sentryWebhook() and larkCallback() route registrations.
 * Each route uses the appropriate InputAdapter to validate and convert the
 * raw payload into a HubEvent, then emits it to the EventBus for processing
 * by Core → RuleRouter → Executor → SubAgent.
 */
export function registerWebhookRoutes(app: Hono, deps: WebhookRoutesDeps): void {
  const { store, eventBus, sentryAdapter, larkAdapter } = deps;

  // --- Sentry webhook: validate → dedup → create task → emit event ---
  app.post("/webhooks/sentry", async (c) => {
    const raw = await c.req.json();
    const event = sentryAdapter.toEvent(raw);
    if (!event) return c.json({ error: "Invalid payload" }, 400);

    const issueId = event.payload.issueId as string;

    // Dedup: skip if an active task already exists for this issue
    const existing = store.findByIssueId(issueId);
    if (existing && !["done", "failed", "ignored", "rejected"].includes(existing.state)) {
      return c.json({ status: "duplicate", taskId: existing.id });
    }

    // Create task before emitting (task must exist for FK constraints in audit_log)
    const task = store.create({
      sentryIssueId: issueId,
      sentryEventId: (event.payload.eventId as string) ?? "",
      title: event.payload.title as string,
      severity: event.payload.severity as string,
    });

    // Enrich event with taskId so the agent can look up the task
    event.payload.taskId = task.id;

    // Fire-and-forget: EventBus → Core → Executor → FaultHealingAgent
    eventBus.emit(event).catch((err) => {
      console.error(`[webhook] Failed to process sentry event:`, err);
    });

    return c.json({ status: "accepted", taskId: task.id });
  });

  // --- Lark callback: challenge → validate → emit event ---
  app.post("/callbacks/lark", async (c) => {
    const raw = await c.req.json();

    // Lark card callback verification challenge
    if (raw.challenge) {
      return c.json({ challenge: raw.challenge });
    }

    const event = larkAdapter.toEvent(raw);
    if (!event) return c.json({ msg: "ok" });

    // For card actions, verify the task exists
    if (event.type === "lark.card_action" && event.payload.taskId) {
      const task = store.getById(event.payload.taskId as string);
      if (!task) return c.json({ msg: "task not found" });
    }

    // Fire-and-forget: EventBus → Core → Executor → FaultHealingAgent
    eventBus.emit(event).catch((err) => {
      console.error(`[webhook] Failed to process lark event:`, err);
    });

    return c.json({ msg: "ok" });
  });
}
