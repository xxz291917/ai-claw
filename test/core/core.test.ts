// test/core/core.test.ts
import { describe, it, expect, vi } from "vitest";
import { Core } from "../../src/core/core.js";
import { RuleRouter } from "../../src/core/rule-router.js";
import { Executor } from "../../src/core/executor.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { createHubEvent } from "../../src/core/hub-event.js";
import { createTestDb } from "../helpers.js";
import type { AgentEvent, SubAgent } from "../../src/agents/types.js";

const fakeAgent: SubAgent = {
  name: "code-fixer",
  description: "fixes code",
  async *execute(): AsyncIterable<AgentEvent> {
    yield { type: "result", content: "fixed" };
  },
};

describe("Core", () => {
  it("routes sentry event via RuleRouter to Executor", async () => {
    const db = createTestDb();
    const outputSend = vi.fn();

    const core = new Core({
      ruleRouter: new RuleRouter([
        {
          match: (e) => e.type === "sentry.issue_alert",
          plan: (e) => ({
            agent: "code-fixer",
            skill: "fault-healing",
            inputs: { issueId: e.payload.issueId },
            outputs: [{ type: "notify", channel: "lark", card: {} }],
          }),
        },
      ]),
      executor: new Executor({
        registry: new AgentRegistry([fakeAgent]),
        db,
        outputSend,
      }),
      sessionManager: new SessionManager(db),
      handleChat: vi.fn(),
    });

    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issueId: "123" },
    });

    await core.handle(event);

    expect(outputSend).toHaveBeenCalled();
  });

  it("routes chat event to handleChat", async () => {
    const db = createTestDb();
    const handleChat = vi.fn();

    const core = new Core({
      ruleRouter: new RuleRouter([]),
      executor: new Executor({
        registry: new AgentRegistry([]),
        db,
        outputSend: vi.fn(),
      }),
      sessionManager: new SessionManager(db),
      handleChat,
    });

    const event = createHubEvent({
      type: "chat.web",
      source: "web_chat",
      payload: { message: "hello" },
      context: { sessionId: "s-1" },
    });

    await core.handle(event);

    expect(handleChat).toHaveBeenCalledWith(event);
  });
});
