import { z } from "zod";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { UnifiedToolDef } from "./types.js";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_MAX_TURNS = 15;
const MAX_OUTPUT_CHARS = 200_000;

type ClaudeCodeConfig = {
  workspaceDir: string;
  maxTurns?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxBudgetUsd?: number;
};

/**
 * Creates a claude_code tool that delegates code tasks to Claude Code CLI.
 *
 * Architecture: Sub-agent pattern.
 * The outer LLM (e.g. DeepSeek) handles conversation and decision-making.
 * Claude Code handles autonomous code reading, editing, searching, and testing.
 *
 * Requires: `claude` CLI installed and `ANTHROPIC_API_KEY` in environment.
 */
export function createClaudeCodeTool(config: ClaudeCodeConfig): UnifiedToolDef {
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeout = config.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  const maxBudget = config.maxBudgetUsd ?? 1.0;
  const cwd = resolve(config.workspaceDir);

  return {
    name: "claude_code",
    description:
      "Delegate a code task to Claude Code (autonomous sub-agent). " +
      "Claude Code can read/write/edit files, search codebases (grep/glob), run shell commands, and run tests — all autonomously. " +
      "Use this for tasks that require understanding and modifying code: bug fixes, refactoring, adding features, code review, etc. " +
      "Provide a clear, specific task description. Returns a summary of what was accomplished.",
    inputSchema: {
      task: z.string().describe("Clear, specific description of the code task to accomplish"),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in seconds (default 300, max 600)"),
    },
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear, specific description of the code task" },
        timeout: { type: "number", description: "Timeout in seconds (default 300, max 600)" },
      },
      required: ["task"],
    },
    execute: async (args: { task: string; timeout?: number }) => {
      return runClaudeCode(args, cwd, maxTurns, maxBudget, defaultTimeout, maxTimeout);
    },
  };
}

async function runClaudeCode(
  args: { task: string; timeout?: number },
  cwd: string,
  maxTurns: number,
  maxBudget: number,
  defaultTimeout: number,
  maxTimeout: number,
): Promise<string> {
  const effectiveCwd = existsSync(cwd) ? cwd : process.cwd();

  const timeoutMs = args.timeout
    ? Math.min(args.timeout * 1000, maxTimeout)
    : defaultTimeout;

  console.log(`[claude_code] Delegating task (cwd=${effectiveCwd}, timeout=${timeoutMs}ms, maxTurns=${maxTurns})`);
  console.log(`[claude_code] Task: ${args.task.slice(0, 200)}`);

  try {
    const result = await execClaudeCli(args.task, {
      cwd: effectiveCwd,
      timeoutMs,
      maxTurns,
      maxBudget,
    });

    if (result.timedOut) {
      const partial = result.stdout.trim();
      return partial
        ? `[Claude Code timed out after ${Math.round(timeoutMs / 1000)}s]\n\nPartial output:\n${partial}`
        : `[Claude Code timed out after ${Math.round(timeoutMs / 1000)}s with no output]`;
    }

    // Try to parse JSON output (--output-format json)
    // stdout may contain multiple JSON lines (streaming events + final result).
    // Try the whole stdout first, then fall back to the last non-empty line.
    const json = tryParseResultJson(result.stdout);
    if (json) {
      const status = json.is_error ? "FAILED" : "completed";
      const cost = json.cost_usd != null ? ` | cost: $${Number(json.cost_usd).toFixed(4)}` : "";
      const turns = json.num_turns != null ? ` | ${json.num_turns} turns` : "";
      const resultText = json.result ?? json.message ?? "";

      if (json.is_error) {
        return `[Claude Code ${status}${turns}${cost}]\n\n${resultText || result.stderr || "Unknown error"}`;
      }

      return `[Claude Code ${status}${turns}${cost}]\n\n${resultText}`;
    }

    // Not JSON — return raw output (stripped of noisy init lines)
    const output = result.stdout.trim() || result.stderr.trim();
    if (result.exitCode !== 0) {
      return `[Claude Code exited with code ${result.exitCode}]\n\n${output || "No output"}`;
    }
    return output || "Claude Code completed with no output.";
  } catch (err: any) {
    if (err.message?.includes("ENOENT")) {
      return "Error: `claude` CLI is not installed. Install it with: npm install -g @anthropic-ai/claude-code";
    }
    return `Error: ${err.message}`;
  }
}

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

function execClaudeCli(
  task: string,
  opts: { cwd: string; timeoutMs: number; maxTurns: number; maxBudget: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // Pass task via environment variable to avoid shell escaping issues.
    // The shell command uses "$CLAUDE_CODE_TASK" (double-quoted) which is
    // safe against word splitting and glob expansion.
    const command = [
      'claude -p "$CLAUDE_CODE_TASK"',
      "--output-format json",
      `--max-turns ${opts.maxTurns}`,
      `--max-budget-usd ${opts.maxBudget}`,
      "--dangerously-skip-permissions",
      "--no-session-persistence",
    ].join(" ");

    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_TASK: task,
        // Unset CLAUDECODE to allow nested invocation
        CLAUDECODE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (stdout.length < MAX_OUTPUT_CHARS) {
        stdout += text.slice(0, MAX_OUTPUT_CHARS - stdout.length);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (stderr.length < MAX_OUTPUT_CHARS) {
        stderr += text.slice(0, MAX_OUTPUT_CHARS - stderr.length);
      }
    });

    child.on("close", (code) => {
      finish(code ?? 0);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);
      setTimeout(() => finish(137), 2000);
    }, opts.timeoutMs);
  });
}

/**
 * Try to extract the final result JSON from stdout.
 * With --output-format json, Claude Code outputs a single JSON object.
 * If stdout contains multiple lines (e.g. streaming noise), try the last line.
 */
function tryParseResultJson(stdout: string): any | null {
  // Try whole stdout first (normal case)
  try {
    const json = JSON.parse(stdout);
    if (json.result !== undefined || json.is_error !== undefined) return json;
  } catch { /* not a single JSON */ }

  // Try last non-empty line (handles mixed output)
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const json = JSON.parse(lines[i]);
      if (json.result !== undefined || json.is_error !== undefined) return json;
    } catch { continue; }
  }

  return null;
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM"); // Graceful first
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch { /* already dead */ }
    }, 3000);
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch { /* already dead */ }
  }
}
