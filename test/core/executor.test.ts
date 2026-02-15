// test/core/executor.test.ts
import { describe, it, expect, vi } from "vitest";
import { Executor } from "../../src/core/executor.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import type { SubAgent, AgentEvent } from "../../src/agents/types.js";
import type { TaskPlan } from "../../src/core/rule-router.js";
import { createHubEvent } from "../../src/core/hub-event.js";
import { createTestDb } from "../helpers.js";

const mockAgent: SubAgent = {
  name: "test-agent",
  description: "test",
  async *execute(): AsyncIterable<AgentEvent> {
    yield { type: "thinking", content: "analyzing..." };
    yield {
      type: "result",
      content: "fixed",
      artifacts: [{ kind: "pr", data: { url: "https://github.com/pr/1" } }],
    };
  },
};

describe("Executor", () => {
  it("runs a plan: finds agent, executes, logs events", async () => {
    const db = createTestDb();
    const registry = new AgentRegistry([mockAgent]);
    const outputSend = vi.fn();
    const executor = new Executor({ registry, db, outputSend });

    const plan: TaskPlan = {
      agent: "test-agent",
      inputs: { issueId: "123" },
      outputs: [{ type: "notify", channel: "lark", card: {} }],
    };
    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issueId: "123" },
    });

    await executor.run(plan, event);

    // outputSend should have been called for the "result" event
    expect(outputSend).toHaveBeenCalled();
  });

  it("throws if agent not found", async () => {
    const db = createTestDb();
    const registry = new AgentRegistry([]);
    const executor = new Executor({ registry, db, outputSend: vi.fn() });

    const plan: TaskPlan = {
      agent: "nonexistent",
      inputs: {},
      outputs: [],
    };
    const event = createHubEvent({ type: "test", source: "test", payload: {} });

    await expect(executor.run(plan, event)).rejects.toThrow("Agent not found");
  });
});
