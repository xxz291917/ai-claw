import { describe, it, expect, vi } from "vitest";
import { createBashExecTool } from "../../src/tools/bash-exec.js";

// Mock child_process to avoid spawning real shell processes
// (prevents intermittent macOS printer dialogs from detached process groups)
vi.mock("node:child_process", () => ({
  spawn: vi.fn((_shell: string, args: string[]) => {
    const EventEmitter = require("node:events");
    const { Readable } = require("node:stream");
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.pid = 99999;

    const command = args?.[1] ?? "";

    setTimeout(() => {
      if (command === "false") {
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit("close", 1);
      } else if (command === "sleep 10") {
        // Don't close — let bash-exec's timeout handler fire
      } else if (command === "echo partial-before-sleep && sleep 30") {
        child.stdout.push(Buffer.from("partial-before-sleep\n"));
        // Don't close — let timeout fire after partial output
      } else if (command.includes("{1..200}")) {
        child.stdout.push(Buffer.from("-".repeat(200)));
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit("close", 0);
      } else if (command.includes("\\x00") || command.includes("\\x07")) {
        child.stdout.push(Buffer.from("hello\x00world\x07end"));
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit("close", 0);
      } else if (command.includes(">&2")) {
        child.stderr.push(Buffer.from("err\n"));
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit("close", 0);
      } else if (command.startsWith("echo")) {
        const text = command.replace(/^echo\s+/, "");
        child.stdout.push(Buffer.from(text + "\n"));
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit("close", 0);
      } else {
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit("close", 0);
      }
    }, 10);

    return child;
  }),
}));

describe("createBashExecTool", () => {
  const defaultConfig = {
    defaultCwd: process.cwd(),
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 10000,
    maxOutputChars: 500,
  };

  it("should execute a simple command", async () => {
    const tool = createBashExecTool(defaultConfig);
    const text = await tool.execute({ command: "echo hello" });

    expect(text).toContain("$ echo hello");
    expect(text).toContain("hello");
    expect(text).toContain("Exit code: 0");
  });

  it("should handle non-zero exit codes without throwing", async () => {
    const tool = createBashExecTool(defaultConfig);
    const text = await tool.execute({ command: "false" });

    expect(text).toContain("Exit code: 1");
  });

  it("should handle command timeout", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      defaultTimeoutMs: 500,
    });
    const text = await tool.execute({ command: "sleep 10" });

    expect(text).toContain("timed out");
  }, 10000);

  it("should truncate large output", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      maxOutputChars: 100,
    });
    const text = await tool.execute({
      command: "printf '%0.s-' {1..200}",
    });

    expect(text.length).toBeLessThanOrEqual(130); // 100 + truncation marker
    expect(text).toContain("...[truncated]...");
  });

  it("should reject commands not in allowlist", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      allowedCommands: ["echo", "cat"],
    });
    const text = await tool.execute({ command: "ls -la" });

    expect(text).toContain("not allowed");
    expect(text).toContain("ls");
    expect(text).toContain("Error:");
  });

  it("should allow commands in allowlist", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      allowedCommands: ["echo", "cat"],
    });
    const text = await tool.execute({ command: "echo allowed" });

    expect(text).toContain("allowed");
    expect(text).toContain("Exit code: 0");
  });

  it("should respect timeout parameter capped at max", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      maxTimeoutMs: 1000,
    });
    // LLM requests 999 seconds but max is 1s — should timeout
    const text = await tool.execute({
      command: "sleep 10",
      timeout: 999,
    });

    expect(text).toContain("timed out");
  }, 10000);

  it("execute should return a string", async () => {
    const tool = createBashExecTool(defaultConfig);
    const text = await tool.execute({ command: "echo plain" });

    expect(typeof text).toBe("string");
    expect(text).toContain("plain");
  });

  it("should capture stderr", async () => {
    const tool = createBashExecTool(defaultConfig);
    const text = await tool.execute({
      command: "echo err >&2",
    });

    expect(text).toContain("[stderr]");
    expect(text).toContain("err");
  });

  it("should return partial output on timeout", async () => {
    const tool = createBashExecTool({
      ...defaultConfig,
      defaultTimeoutMs: 1000,
    });
    const text = await tool.execute({
      command: "echo partial-before-sleep && sleep 30",
    });

    expect(text).toContain("partial-before-sleep");
    expect(text).toContain("timed out");
    expect(text).toContain("partial output above");
  }, 10000);

  it("should sanitize binary output", async () => {
    const tool = createBashExecTool(defaultConfig);
    const text = await tool.execute({
      command: "printf 'hello\\x00world\\x07end'",
    });

    expect(text).toContain("hello");
    expect(text).toContain("world");
    expect(text).toContain("end");
    expect(text).not.toContain("\x00");
    expect(text).not.toContain("\x07");
  });
});
