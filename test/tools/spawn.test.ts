import { describe, it, expect } from "vitest";
import { createSpawnTool } from "../../src/tools/spawn.js";
import { SubagentManager } from "../../src/subagent/manager.js";
import { ProviderRegistry } from "../../src/chat/provider-registry.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { createTestDb } from "../helpers.js";

describe("spawn tool", () => {
  it("calls subagentManager.spawn and returns task id", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => ({
        name: "test",
        async *stream() {
          yield { type: "text" as const, content: "done" };
          yield { type: "done" as const, sessionId: "", costUsd: 0 };
        },
      }),
    });

    const manager = new SubagentManager({ registry, sessionManager });
    const tool = createSpawnTool(manager, "test");

    const result = await tool.execute(
      { task: "research something" },
      { userId: "user-1", sessionId: "session-1" },
    );

    expect(result).toContain("后台任务已启动");
    expect(manager.listBySession("session-1")).toHaveLength(1);
  });

  it("uses provided provider name instead of default", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();
    registry.register({
      name: "default",
      type: "openai-compatible",
      factory: () => ({
        name: "default",
        async *stream() {
          yield { type: "done" as const, sessionId: "", costUsd: 0 };
        },
      }),
    });
    registry.register({
      name: "custom",
      type: "openai-compatible",
      factory: () => ({
        name: "custom",
        async *stream() {
          yield { type: "done" as const, sessionId: "", costUsd: 0 };
        },
      }),
    });

    const manager = new SubagentManager({ registry, sessionManager });
    const tool = createSpawnTool(manager, "default");

    await tool.execute(
      { task: "use custom provider", provider: "custom" },
      { userId: "user-1", sessionId: "session-1" },
    );

    const tasks = manager.listBySession("session-1");
    expect(tasks[0].providerName).toBe("custom");
  });
});
