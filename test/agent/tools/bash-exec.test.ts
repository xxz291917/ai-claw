import { describe, it, expect } from "vitest";
import { createBashExecTool } from "../../../src/agent/tools/bash-exec.js";

describe("createBashExecTool", () => {
  const defaultConfig = {
    defaultCwd: process.cwd(),
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 10000,
    maxOutputChars: 500,
  };

  it("should execute a simple command", async () => {
    const tool = createBashExecTool(defaultConfig);
    const result = await tool.handler({ command: "echo hello" });
    const text = result.content[0].text;

    expect(text).toContain("$ echo hello");
    expect(text).toContain("hello");
    expect(text).toContain("Exit code: 0");
  });

  it("should handle non-zero exit codes without throwing", async () => {
    const tool = createBashExecTool(defaultConfig);
    const result = await tool.handler({ command: "false" });
    const text = result.content[0].text;

    expect(text).toContain("Exit code: 1");
  });

  it("should handle command timeout", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      defaultTimeoutMs: 500,
    });
    const result = await tool.handler({ command: "sleep 10" });
    const text = result.content[0].text;

    expect(text).toContain("timed out");
  }, 10000);

  it("should truncate large output", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      maxOutputChars: 100,
    });
    const result = await tool.handler({
      command: "printf '%0.s-' {1..200}",
    });
    const text = result.content[0].text;

    expect(text.length).toBeLessThanOrEqual(130); // 100 + truncation marker
    expect(text).toContain("...[truncated]...");
  });

  it("should reject commands not in allowlist", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      allowedCommands: ["echo", "cat"],
    });
    const result = await tool.handler({ command: "ls -la" });
    const text = result.content[0].text;

    expect(text).toContain("not allowed");
    expect(text).toContain("ls");
    expect(result.isError).toBe(true);
  });

  it("should allow commands in allowlist", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      allowedCommands: ["echo", "cat"],
    });
    const result = await tool.handler({ command: "echo allowed" });
    const text = result.content[0].text;

    expect(text).toContain("allowed");
    expect(text).toContain("Exit code: 0");
  });

  it("should respect timeout parameter capped at max", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      maxTimeoutMs: 1000,
    });
    // LLM requests 999 seconds but max is 1s — should timeout
    const result = await tool.handler({
      command: "sleep 10",
      timeout: 999,
    });
    const text = result.content[0].text;

    expect(text).toContain("timed out");
  }, 10000);

  it("plainHandler should return a string", async () => {
    const tool = createBashExecTool(defaultConfig);
    const text = await tool.plainHandler({ command: "echo plain" });

    expect(typeof text).toBe("string");
    expect(text).toContain("plain");
  });

  it("should capture stderr", async () => {
    const tool = createBashExecTool(defaultConfig);
    const result = await tool.handler({
      command: "echo err >&2",
    });
    const text = result.content[0].text;

    expect(text).toContain("[stderr]");
    expect(text).toContain("err");
  });
});
