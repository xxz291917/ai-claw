import { z } from "zod";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { UnifiedToolDef } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 120s — enough for git, npm, sqlite3
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_MAX_OUTPUT = 200_000; // 200KB (was 50KB)

type BashExecConfig = {
  defaultCwd: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputChars?: number;
  allowedCommands?: string[];
};

/**
 * Creates a bash_exec tool that executes shell commands locally.
 *
 * Key design decisions (borrowed from OpenClaw):
 * - Uses `spawn` instead of `execFile` for streaming output collection
 * - Spawns detached process group so timeout can kill the entire tree
 * - Collects output incrementally — timeout returns partial output, not empty error
 * - Sanitizes binary output to prevent garbled responses
 * - Default timeout 120s (was 30s) to handle git/npm/sqlite operations
 */
export function createBashExecTool(config: BashExecConfig): UnifiedToolDef {
  const defaultTimeout = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeout = config.maxTimeoutMs ?? MAX_TIMEOUT_MS;
  const maxOutput = config.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const resolvedDefaultCwd = resolve(config.defaultCwd);

  return {
    name: "bash_exec",
    description:
      "Execute a shell command locally and return its output. " +
      "Commands run in the workspace root by default. " +
      "Use this for running CLI tools (git, gh, curl, sqlite3, etc.), " +
      "inspecting files, or performing system operations. " +
      "Do NOT set the cwd parameter unless you have a specific reason — the default is almost always correct.",
    inputSchema: {
      command: z.string().describe("Shell command to execute"),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in seconds (default 120, max 600)"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory. Omit to use workspace root — do NOT guess paths."),
    },
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120, max 600)" },
        cwd: { type: "string", description: "Working directory. Omit to use workspace root" },
      },
      required: ["command"],
    },
    execute: async (args: { command: string; timeout?: number; cwd?: string }) => {
      return runCommand(args, resolvedDefaultCwd, defaultTimeout, maxTimeout, maxOutput, config.allowedCommands);
    },
  };
}

async function runCommand(
  args: { command: string; timeout?: number; cwd?: string },
  defaultCwd: string,
  defaultTimeout: number,
  maxTimeout: number,
  maxOutput: number,
  allowedCommands?: string[],
): Promise<string> {
  const { command } = args;

  // Allowlist check — also reject shell metacharacters to prevent bypass
  if (allowedCommands) {
    const bin = command.trim().split(/\s/)[0];
    if (!allowedCommands.includes(bin)) {
      return `Error: Command "${bin}" is not allowed. Allowed: ${allowedCommands.join(", ")}`;
    }
    // Block shell metacharacters that could chain additional commands
    if (/[;|&`$(){}<>]/.test(command)) {
      return `Error: Shell metacharacters are not allowed when command allowlist is active.`;
    }
  }

  let cwd = args.cwd ? resolve(args.cwd) : defaultCwd;

  // Fallback chain: args.cwd → defaultCwd → process.cwd()
  // spawn() throws ENOENT when cwd doesn't exist (not just when binary is missing)
  if (!existsSync(cwd)) {
    console.warn(`[bash_exec] cwd "${cwd}" does not exist, falling back to default: ${defaultCwd}`);
    cwd = defaultCwd;
  }
  if (!existsSync(cwd)) {
    console.warn(`[bash_exec] default cwd "${cwd}" also missing, falling back to process.cwd(): ${process.cwd()}`);
    cwd = process.cwd();
  }

  const timeoutMs = args.timeout
    ? Math.min(args.timeout * 1000, maxTimeout)
    : defaultTimeout;

  console.log(`[bash_exec] Running: ${command} (cwd=${cwd}, timeout=${timeoutMs}ms)`);

  try {
    const result = await execStreaming(command, { cwd, timeoutMs, maxOutput });

    let output = `$ ${command}\n`;
    if (result.stdout) output += result.stdout;
    if (result.stderr) output += `\n[stderr]\n${result.stderr}`;

    if (result.timedOut) {
      output += `\n[timed out after ${Math.round(timeoutMs / 1000)}s — partial output above]`;
    } else {
      output += `\nExit code: ${result.exitCode}`;
    }

    return truncateOutput(output, maxOutput);
  } catch (err: any) {
    console.error(`[bash_exec] Error:`, err.message);
    return `Error: ${err.message}`;
  }
}

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

/**
 * Streaming exec using `spawn` with process-group kill.
 *
 * Advantages over `execFile`:
 * - Output is collected incrementally, so timeout returns partial results
 * - Spawns a detached process group, so `kill(-pid)` cleans up the entire tree
 * - No maxBuffer limit — we manage output capping ourselves
 * - Binary output is sanitized to prevent garbled responses
 */
function execStreaming(
  command: string,
  opts: { cwd: string; timeoutMs: number; maxOutput: number },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: { ...process.env, TERM: "dumb", CUPS_SERVER: "" }, // Suppress terminal escape sequences and macOS printer dialogs
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // Create process group for clean kill
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: sanitizeBinaryOutput(stdout),
        stderr: sanitizeBinaryOutput(stderr),
        exitCode,
        timedOut,
      });
    };

    // --- Stream output collection ---
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (stdout.length < opts.maxOutput) {
        stdout += text.slice(0, opts.maxOutput - stdout.length);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (stderr.length < opts.maxOutput) {
        stderr += text.slice(0, opts.maxOutput - stderr.length);
      }
    });

    // --- Process exit ---
    child.on("close", (code) => {
      finish(code ?? 0);
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          stdout: sanitizeBinaryOutput(stdout),
          stderr: `Spawn error: ${err.message}`,
          exitCode: 1,
          timedOut: false,
        });
      }
    });

    // --- Timeout: kill process group, return partial output ---
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);
      // Give 1s grace period for streams to flush, then force-resolve
      setTimeout(() => finish(137), 1000);
    }, opts.timeoutMs);
  });
}

/**
 * Kill the entire process group (sh + all children).
 * On POSIX, `kill(-pid)` sends signal to the process group.
 * Falls back to killing just the process if group kill fails.
 */
function killProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    // Kill process group (negative pid)
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group kill failed (e.g., process already exited) — try direct kill
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead — ignore
    }
  }
}

/**
 * Strip non-printable characters from command output.
 * Prevents garbled responses when commands accidentally output binary data.
 * Borrowed from OpenClaw's sanitizeBinaryOutput().
 */
function sanitizeBinaryOutput(text: string): string {
  if (!text) return text;
  const chunks: string[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    // Keep: tab (0x09), newline (0x0a), carriage return (0x0d), printable (>= 0x20)
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) {
      chunks.push(char);
    }
  }
  return chunks.join("");
}

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 30) / 2);
  return (
    text.slice(0, half) +
    "\n...[truncated]...\n" +
    text.slice(-half)
  );
}
