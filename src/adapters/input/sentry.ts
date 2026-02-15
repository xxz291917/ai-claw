import { z } from "zod";
import type { InputAdapter } from "./types.js";
import { createHubEvent, type HubEvent } from "../../core/hub-event.js";

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

export class SentryInputAdapter implements InputAdapter {
  readonly source = "sentry";

  toEvent(raw: unknown): HubEvent | null {
    const parsed = sentryPayloadSchema.safeParse(raw);
    if (!parsed.success) return null;

    const { data } = parsed.data;
    return createHubEvent({
      type: "sentry.issue_alert",
      source: this.source,
      payload: {
        issueId: data.issue.id,
        eventId: data.event?.event_id ?? "",
        title: data.issue.title,
        severity: mapSeverity(data.issue.level),
        level: data.issue.level,
      },
    });
  }
}
