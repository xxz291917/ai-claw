import { describe, it, expect } from "vitest";
import {
  buildDiagnosisCard,
  buildPrReadyCard,
} from "../../src/lark/notify.js";

describe("Lark card builders", () => {
  it("builds diagnosis card with correct structure", () => {
    const card = buildDiagnosisCard({
      taskId: "task-1",
      title: "TypeError at handler.ts:42",
      severity: "P1",
      rootCause: "Null reference in user lookup",
      confidence: "92%",
      impact: "1.2k users",
    });

    expect(card.header.title.content).toContain("P1");
    const actions = card.elements.find((e: any) => e.tag === "action");
    expect(actions).toBeDefined();
  });

  it("builds PR ready card with correct structure", () => {
    const card = buildPrReadyCard({
      taskId: "task-2",
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      filesChanged: 3,
      linesAdded: 12,
      testsPassed: 8,
      testsFailed: 0,
    });

    expect(card.header.title.content).toContain("PR");
    const actions = card.elements.find((e: any) => e.tag === "action");
    expect(actions).toBeDefined();
  });

  it("shows CI failure when tests fail", () => {
    const card = buildPrReadyCard({
      taskId: "task-3",
      prUrl: "https://github.com/org/repo/pull/43",
      prNumber: 43,
      filesChanged: 1,
      linesAdded: 5,
      testsPassed: 7,
      testsFailed: 2,
    });

    const testElement = card.elements.find(
      (e: any) => e.text?.content?.includes("失败"),
    );
    expect(testElement).toBeDefined();
  });
});
