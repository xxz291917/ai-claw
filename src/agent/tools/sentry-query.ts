import { z } from "zod";

type SentryConfig = {
  authToken: string;
  org: string;
  project: string;
};

/**
 * Creates a sentry_query tool definition for the Claude Agent SDK.
 */
export function createSentryQueryTool(config: SentryConfig) {
  return {
    name: "sentry_query",
    description:
      "Query Sentry for issue details including error message, stacktrace, affected users, and frequency. Use this to understand the error before reading code.",
    inputSchema: {
      issue_id: z.string().describe("Sentry issue ID"),
    },
    handler: async (args: { issue_id: string }) => {
      const url = `https://sentry.io/api/0/organizations/${config.org}/issues/${args.issue_id}/`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.authToken}` },
      });

      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Sentry API error: ${res.status} ${res.statusText}`,
            },
          ],
          isError: true,
        };
      }

      const issue = (await res.json()) as Record<string, unknown>;

      // Fetch latest event for stacktrace
      const eventUrl = `https://sentry.io/api/0/organizations/${config.org}/issues/${args.issue_id}/events/latest/`;
      const eventRes = await fetch(eventUrl, {
        headers: { Authorization: `Bearer ${config.authToken}` },
      });
      const event = eventRes.ok
        ? ((await eventRes.json()) as Record<string, unknown>)
        : null;

      const summary = {
        id: issue.id,
        title: issue.title,
        level: issue.level,
        count: issue.count,
        userCount: issue.userCount,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        status: issue.status,
        stacktrace: event ? extractStacktrace(event) : "unavailable",
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    },
  };
}

function extractStacktrace(event: Record<string, unknown>): string {
  try {
    const entries = (event as any).entries ?? [];
    for (const entry of entries) {
      if (entry.type === "exception") {
        const values = entry.data?.values ?? [];
        return values
          .map((v: any) => {
            const frames = v.stacktrace?.frames ?? [];
            const topFrames = frames.slice(-5).reverse();
            return [
              `${v.type}: ${v.value}`,
              ...topFrames.map(
                (f: any) =>
                  `  at ${f.function ?? "?"} (${f.filename}:${f.lineNo})`,
              ),
            ].join("\n");
          })
          .join("\n\n");
      }
    }
  } catch {
    // fall through
  }
  return "Could not extract stacktrace";
}
