import { describe, it, expect } from "vitest";
import { RuleRouter, type Route } from "../../src/core/rule-router.js";
import { createHubEvent } from "../../src/core/hub-event.js";

describe("RuleRouter", () => {
  it("matches a sentry event to a route", () => {
    const routes: Route[] = [
      {
        match: (e) => e.type === "sentry.issue_alert",
        plan: (e) => ({
          agent: "code-fixer",
          skill: "fault-healing",
          inputs: { issueId: e.payload.issueId },
          outputs: [{ type: "notify", channel: "lark", card: {} }],
        }),
      },
    ];

    const router = new RuleRouter(routes);
    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issueId: "123" },
    });

    const plan = router.match(event);
    expect(plan).not.toBeNull();
    expect(plan!.agent).toBe("code-fixer");
    expect(plan!.inputs.issueId).toBe("123");
  });

  it("returns null when no route matches", () => {
    const router = new RuleRouter([]);
    const event = createHubEvent({
      type: "unknown.event",
      source: "unknown",
      payload: {},
    });

    expect(router.match(event)).toBeNull();
  });

  it("uses first matching route", () => {
    const routes: Route[] = [
      {
        match: (e) => e.type === "sentry.issue_alert",
        plan: () => ({ agent: "first", inputs: {}, outputs: [] }),
      },
      {
        match: (e) => e.type === "sentry.issue_alert",
        plan: () => ({ agent: "second", inputs: {}, outputs: [] }),
      },
    ];

    const router = new RuleRouter(routes);
    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: {},
    });

    expect(router.match(event)!.agent).toBe("first");
  });
});
