import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { TaskStore } from "../../src/tasks/store.js";
import { FaultHealingWorkflow } from "../../src/workflows/fault-healing.js";
import { FaultHealingAgent } from "../../src/agents/fault-healing.js";
import type { AgentEvent } from "../../src/agents/types.js";
import type Database from "better-sqlite3";

async function collectEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of iter) {
    events.push(ev);
  }
  return events;
}

describe("FaultHealingAgent", () => {
  let db: Database.Database;
  let store: TaskStore;
  let workflow: FaultHealingWorkflow;
  let agent: FaultHealingAgent;

  const mockRunAgent = vi.fn();
  const mockSendCard = vi.fn().mockResolvedValue("msg-123");

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    workflow = new FaultHealingWorkflow({
      store,
      runAgent: mockRunAgent,
      sendLarkCard: mockSendCard,
    });
    agent = new FaultHealingAgent({ workflow, store });
    mockRunAgent.mockReset();
    mockSendCard.mockReset().mockResolvedValue("msg-123");
  });

  it("has correct name and description", () => {
    expect(agent.name).toBe("fault-healing");
    expect(agent.description).toContain("Sentry");
  });

  it("runs analysis skill: yields thinking then result", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-1",
      sentryEventId: "evt-1",
      title: "TypeError",
      severity: "P1",
    });

    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({ rootCause: "Null ref", confidence: "90%" }),
      sessionId: "sess-1",
      costUsd: 0.05,
    });

    const events = await collectEvents(
      agent.execute({
        taskId: task.id,
        skill: "analysis",
        inputs: { taskId: task.id },
        provider: "claude",
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("thinking");
    expect(events[1].type).toBe("result");
    if (events[1].type === "result") {
      expect(events[1].content).toContain("Null ref");
      expect(events[1].artifacts).toHaveLength(1);
      expect(events[1].artifacts![0].kind).toBe("analysis");
    }
  });

  it("runs action skill: yields thinking then result", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-2",
      sentryEventId: "evt-2",
      title: "Error",
      severity: "P2",
    });
    store.transition(task.id, "analyze");
    store.transition(task.id, "report");

    const events = await collectEvents(
      agent.execute({
        taskId: task.id,
        skill: "action",
        inputs: { taskId: task.id, action: "ignore" },
        provider: "claude",
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("thinking");
    expect(events[1].type).toBe("result");
    if (events[1].type === "result") {
      expect(events[1].content).toContain("ignore");
      expect(events[1].content).toContain("ignored");
    }

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("ignored");
  });

  it("yields pr artifact on fix action", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-3",
      sentryEventId: "evt-3",
      title: "TypeError",
      severity: "P1",
    });
    store.transition(task.id, "analyze");
    store.transition(task.id, "report");

    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        filesChanged: 2,
        linesAdded: 8,
        testsPassed: 15,
        testsFailed: 0,
      }),
      sessionId: "sess-3",
      costUsd: 0.12,
    });

    const events = await collectEvents(
      agent.execute({
        taskId: task.id,
        skill: "action",
        inputs: { taskId: task.id, action: "fix" },
        provider: "claude",
      }),
    );

    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent?.type === "result") {
      expect(resultEvent.artifacts).toHaveLength(1);
      expect(resultEvent.artifacts![0].kind).toBe("pr");
      expect(resultEvent.artifacts![0].data.url).toContain("/pull/42");
    }
  });

  it("yields error on workflow failure", async () => {
    const events = await collectEvents(
      agent.execute({
        taskId: "nonexistent-task",
        skill: "analysis",
        inputs: { taskId: "nonexistent-task" },
        provider: "claude",
      }),
    );

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.message).toContain("not found");
    }
  });

  it("yields error on missing taskId", async () => {
    const events = await collectEvents(
      agent.execute({
        taskId: "",
        skill: "analysis",
        inputs: {},
        provider: "claude",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("yields error on unknown skill", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-4",
      sentryEventId: "evt-4",
      title: "Error",
      severity: "P2",
    });

    const events = await collectEvents(
      agent.execute({
        taskId: task.id,
        skill: "unknown",
        inputs: { taskId: task.id },
        provider: "claude",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type === "error") {
      expect(events[0].message).toContain("Unknown skill");
    }
  });
});
