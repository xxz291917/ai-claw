import { describe, it, expect } from "vitest";
import { buildNotificationCard } from "../../src/lark/notify.js";

describe("buildNotificationCard", () => {
  it("builds card with correct header and body", () => {
    const card = buildNotificationCard({
      title: "Sentry issue detected",
      severity: "P1",
      body: "**Error:** TypeError at handler.ts:42",
    });

    expect(card.header.title.content).toContain("P1");
    expect(card.header.template).toBe("red");
    expect(card.elements[0].text.content).toContain("TypeError");
  });

  it("includes link button when linkUrl provided", () => {
    const card = buildNotificationCard({
      title: "PR created",
      severity: "P2",
      body: "Fix submitted",
      linkUrl: "https://github.com/org/repo/pull/42",
      linkLabel: "View PR",
    });

    expect(card.header.template).toBe("orange");
    const actions = card.elements.find((e: any) => e.tag === "action");
    expect(actions).toBeDefined();
    expect(actions.actions[0].url).toBe("https://github.com/org/repo/pull/42");
    expect(actions.actions[0].text.content).toBe("View PR");
  });

  it("omits action section when no linkUrl", () => {
    const card = buildNotificationCard({
      title: "Info",
      severity: "P3",
      body: "Just a notification",
    });

    const actions = card.elements.find((e: any) => e.tag === "action");
    expect(actions).toBeUndefined();
  });
});
