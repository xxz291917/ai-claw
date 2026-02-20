import { describe, it, expect } from "vitest";
import type { BatchAgentConfig } from "../../src/agent/runner.js";

describe("BatchAgentConfig", () => {
  it("accepts pre-built mcpServers and systemPrompt", () => {
    const config: BatchAgentConfig = {
      workspaceDir: "/tmp/test-repo",
      systemPrompt: "You are a fault healer.",
      mcpServers: { "ai-hub-tools": {} },
      maxBudgetUsd: 1.0,
    };

    expect(config.workspaceDir).toBe("/tmp/test-repo");
    expect(config.systemPrompt).toContain("fault healer");
    expect(config.mcpServers["ai-hub-tools"]).toBeDefined();
    expect(config.maxBudgetUsd).toBe(1.0);
  });

  it("has sensible defaults for optional fields", () => {
    const config: BatchAgentConfig = {
      workspaceDir: "/tmp/test",
      systemPrompt: "test",
      mcpServers: {},
    };

    expect(config.maxTurns).toBeUndefined();
    expect(config.maxBudgetUsd).toBeUndefined();
    expect(config.env).toBeUndefined();
  });
});
