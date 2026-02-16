import { z } from "zod";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT = 50_000;

type BashExecConfig = {
  defaultCwd: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputChars?: number;
  allowedCommands?: string[];
};

/**
 * Creates a bash_exec tool that executes shell commands locally.
 * Supports configurable timeout, working directory, output truncation,
 * and optional command allowlist.
 */
export function createBashExecTool(config: BashExecConfig) {
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
        .describe("Timeout in seconds (default 30, max 300)"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory. Omit to use workspace root — do NOT guess paths."),
    },
    handler: async (args: {
      command: string;
      timeout?: number;
      cwd?: string;
    }) => {
      const text = await runCommand(args, resolvedDefaultCwd, defaultTimeout, maxTimeout, maxOutput, config.allowedCommands);
      const isError = text.startsWith("Error:");
      return { content: [{ type: "text" as const, text }], ...(isError && { isError: true }) };
    },
    plainHandler: async (args: {
      command: string;
      timeout?: number;
      cwd?: string;
    }): Promise<string> => {
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

  // Allowlist check
  if (allowedCommands) {
    const bin = command.trim().split(/\s/)[0];
    if (!allowedCommands.includes(bin)) {
      return `Error: Command "${bin}" is not allowed. Allowed: ${allowedCommands.join(", ")}`;
    }
  }

  let cwd = args.cwd ? resolve(args.cwd) : defaultCwd;

  // Fallback to default if cwd doesn't exist (prevents LLM-fabricated paths from failing)
  if (!existsSync(cwd)) {
    console.warn(`[bash_exec] cwd "${cwd}" does not exist, falling back to default: ${defaultCwd}`);
    cwd = defaultCwd;
  }

  const timeoutMs = args.timeout
    ? Math.min(args.timeout * 1000, maxTimeout)
    : defaultTimeout;

  console.log(`[bash_exec] Running: ${command} (cwd=${cwd}, timeout=${timeoutMs}ms)`);

  try {
    const { stdout, stderr, exitCode } = await exec(command, {
      cwd,
      timeoutMs,
      maxBuffer: maxOutput * 2,
    });

    let output = `$ ${command}\n`;
    if (stdout) output += stdout;
    if (stderr) output += `\n[stderr]\n${stderr}`;
    output += `\nExit code: ${exitCode}`;

    return truncateOutput(output, maxOutput);
  } catch (err: any) {
    console.error(`[bash_exec] Error:`, err.message);
    if (err.killed) {
      return `$ ${command}\nCommand timed out after ${Math.round(timeoutMs / 1000)}s`;
    }
    return `Error: ${err.message}`;
  }
}

function exec(
  command: string,
  opts: { cwd: string; timeoutMs: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "sh",
      ["-c", command],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(error);
          return;
        }

        // error.code can be a string ('ENOENT') or number (exit code)
        let exitCode = 0;
        if (error) {
          exitCode =
            typeof (error as any).code === "number"
              ? (error as any).code
              : child.exitCode ?? 1;
        } else {
          exitCode = child.exitCode ?? 0;
        }

        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode,
        });
      },
    );
  });
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
