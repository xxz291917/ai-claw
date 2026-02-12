import { describe, it, expect } from "vitest";
import { buildAgentOptions } from "../../src/agent/runner.js";

describe("buildAgentOptions", () => {
  it("returns valid options with MCP tools and system prompt", () => {
    const opts = buildAgentOptions({
      workspaceDir: "/tmp/test-repo",
      sentryConfig: { authToken: "t", org: "o", project: "p" },
      skillContent: "You are a fault healer.",
      maxBudgetUsd: 1.0,
    });

    expect(opts.cwd).toBe("/tmp/test-repo");
    expect(opts.systemPrompt).toContain("fault healer");
    expect(opts.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(opts.mcpServers).toBeDefined();
    expect(opts.mcpServers["ai-hub-tools"]).toBeDefined();
    expect(opts.maxBudgetUsd).toBe(1.0);
    expect(opts.permissionMode).toBe("bypassPermissions");
  });
});
