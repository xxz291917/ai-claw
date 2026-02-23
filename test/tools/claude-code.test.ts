import { describe, it, expect, vi } from "vitest";
import { createClaudeCodeTool } from "../../src/tools/claude-code.js";

const ctx = { userId: "test", sessionId: "test" };

// Mock child_process to avoid spawning real claude CLI
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const EventEmitter = require("node:events");
    const { Readable } = require("node:stream");
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.pid = 99999;
    // Simulate successful JSON output after short delay
    setTimeout(() => {
      child.stdout.push(
        JSON.stringify({ result: "Task completed.", is_error: false, num_turns: 1, cost_usd: 0.001 }),
      );
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit("close", 0);
    }, 50);
    return child;
  }),
}));

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

    const result = await tool.execute({ task: "echo test" }, ctx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("Task completed");
  });

  it("should handle non-existent workspace gracefully", async () => {
    const tool = createClaudeCodeTool({
      ...defaultConfig,
      workspaceDir: "/nonexistent/path/that/should/not/exist",
      defaultTimeoutMs: 5000,
    });

    const result = await tool.execute({ task: "echo fallback test" }, ctx);
    expect(typeof result).toBe("string");
    expect(result).toContain("Task completed");
  });
});
