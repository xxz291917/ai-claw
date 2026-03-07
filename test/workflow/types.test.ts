import { describe, it, expect } from "vitest";
import { stepType } from "../../src/workflow/types.js";
import type { WorkflowStep } from "../../src/workflow/types.js";

describe("stepType", () => {
  it("identifies command steps", () => {
    const step: WorkflowStep = { id: "s1", command: "git status" };
    expect(stepType(step)).toBe("command");
  });

  it("identifies llm steps", () => {
    const step: WorkflowStep = { id: "s2", type: "llm", prompt: "analyze" };
    expect(stepType(step)).toBe("llm");
  });

  it("identifies approval steps", () => {
    const step: WorkflowStep = { id: "s3", approval: { prompt: "ok?" } };
    expect(stepType(step)).toBe("approval");
  });
});
