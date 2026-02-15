import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../../src/agents/registry.js";
import type { SubAgent, TaskExecution, AgentEvent } from "../../src/agents/types.js";

const fakeAgent: SubAgent = {
  name: "test-agent",
  description: "A test agent",
  async *execute(_task: TaskExecution): AsyncIterable<AgentEvent> {
    yield { type: "result", content: "done" };
  },
};

describe("AgentRegistry", () => {
  it("registers and retrieves agent by name", () => {
    const registry = new AgentRegistry([fakeAgent]);
    expect(registry.get("test-agent")).toBe(fakeAgent);
  });

  it("returns undefined for unknown agent", () => {
    const registry = new AgentRegistry([fakeAgent]);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all agents", () => {
    const registry = new AgentRegistry([fakeAgent]);
    expect(registry.list()).toEqual([
      { name: "test-agent", description: "A test agent" },
    ]);
  });
});
