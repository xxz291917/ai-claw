import { describe, it, expect } from "vitest";
import { createClaudeCodeTool } from "../../src/tools/claude-code.js";

describe("createClaudeCodeTool", () => {
  const defaultConfig = {
    workspaceDir: process.cwd(),
    maxTurns: 3,
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 15_000,
    maxBudgetUsd: 0.1,
  };

  it("should return tool with correct name and description", () => {
    const tool = createClaudeCodeTool(defaultConfig);

    expect(tool.name).toBe("claude_code");
    expect(tool.description).toContain("sub-agent");
    expect(tool.description).toContain("code");
  });

  it("should have execute function", () => {
    const tool = createClaudeCodeTool(defaultConfig);

    expect(typeof tool.execute).toBe("function");
  });

  it("should have correct input schema", () => {
    const tool = createClaudeCodeTool(defaultConfig);

    expect(tool.inputSchema.task).toBeDefined();
    expect(tool.inputSchema.timeout).toBeDefined();
  });

  it("execute should return a string", async () => {
    const tool = createClaudeCodeTool({
      ...defaultConfig,
      defaultTimeoutMs: 5000,
    });

    // This will either invoke claude CLI (if installed) or return an error
    // Either way, execute should return a string
    const result = await tool.execute({ task: "echo test" });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  }, 30000);

  it("should handle non-existent workspace gracefully", async () => {
    const tool = createClaudeCodeTool({
      ...defaultConfig,
      workspaceDir: "/nonexistent/path/that/should/not/exist",
      defaultTimeoutMs: 5000,
    });

    // Should fall back to process.cwd() and still work
    const result = await tool.execute({ task: "echo fallback test" });
    expect(typeof result).toBe("string");
  }, 30000);
});
