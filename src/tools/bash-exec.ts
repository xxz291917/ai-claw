import { z } from "zod";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { UnifiedToolDef, ToolContext } from "./types.js";
import type { UserSecretsManager } from "../secrets/manager.js";
import { log } from "../logger.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 120s — enough for git, npm, sqlite3
const MAX_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_MAX_OUTPUT = 200_000; // 200KB (was 50KB)

/** Keys containing these substrings are stripped from child process env */
const SENSITIVE_ENV_SUBSTRINGS = ["KEY", "SECRET", "TOKEN", "PASSWORD", "CREDENTIAL"];

/** Env var prefixes that enable library/binary injection — always blocked */
const DANGEROUS_PREFIXES = ["LD_", "DYLD_", "BASH_FUNC_"];

/** Exact env var names allowed through despite matching SENSITIVE_ENV_SUBSTRINGS */
const ENV_ALLOWLIST = new Set(["GH_TOKEN"]);

/** Sensitive file patterns — blocks commands referencing .env, keys, credentials, etc. */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
  /^\.netrc$/,
  /^\.npmrc$/,
  /^credentials\.json$/i,
  /^secrets?\./i,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
];

function isSensitiveFile(token: string): boolean {
  const name = token.split("/").pop() || token;
  return SENSITIVE_FILE_PATTERNS.some((p) => p.test(name));
}

/** Remove sensitive env vars so child processes can't leak them via `env`/`printenv` */
function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (SENSITIVE_ENV_SUBSTRINGS.some((s) => upper.includes(s)) && !ENV_ALLOWLIST.has(k)) continue;
    if (DANGEROUS_PREFIXES.some((p) => upper.startsWith(p))) continue;
    safe[k] = v;
  }
  return safe;
}

/** Commands with side effects that require user confirmation */
const MUTATING_PREFIXES = [
  "git commit", "git push", "git merge", "git rebase", "git reset", "git checkout",
  "git branch -d", "git branch -D", "git tag",
  "rm ", "rm\t", "rmdir", "mv ", "mv\t", "cp ", "cp\t",
  "chmod", "chown", "mkdir",
  "npm install", "npm i ", "npm i\t", "npm uninstall", "npm publish", "npm run",
  "npx ", "yarn ", "pnpm ",
  "docker ", "kubectl ",
  "curl -X POST", "curl -X PUT", "curl -X DELETE", "curl -X PATCH",
  "wget ",
  "pip install", "pip uninstall",
  "brew install", "brew uninstall",
  "apt ", "yum ", "dnf ", "pacman ",
];

function isMutatingCommand(command: string): boolean {
  const trimmed = command.trimStart();
  return MUTATING_PREFIXES.some((p) => trimmed.startsWith(p));
}

type BashExecConfig = {
  defaultCwd: string;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxOutputChars?: number;
  allowedCommands?: string[];
  secretsManager?: UserSecretsManager;
  /** Secret keys allowed for injection (from skill `secrets` declarations). When set, only these keys are injected. */
  allowedSecretKeys?: string[];
};

/**
 * Resolve which user secrets to inject as env vars.
 *
 * Scoping logic:
 * 1. If `inject_secrets` is provided, only inject those keys (intersected with allowedSecretKeys)
 * 2. If `allowedSecretKeys` is set (from skill `secrets` declarations), inject only those
 * 3. If neither is set, inject all user secrets (backward compat / no skills declare secrets)
 */
function resolveSecrets(
  config: BashExecConfig,
  userId: string,
  injectSecrets?: string[],
): Record<string, string> {
  if (!config.secretsManager) return {};

  const all = config.secretsManager.getAllDecrypted(userId);
  if (Object.keys(all).length === 0) return {};

  // No scoping configured — inject all (backward compat)
  if (!config.allowedSecretKeys && !injectSecrets) return all;

  const allowedSet = config.allowedSecretKeys
    ? new Set(config.allowedSecretKeys.map((k) => k.toUpperCase()))
    : null;

  // Determine which keys to inject
  const requestedKeys = injectSecrets ?? config.allowedSecretKeys ?? [];
  const result: Record<string, string> = {};

  for (const key of requestedKeys) {
    const upper = key.toUpperCase();
    // If allowedSecretKeys is configured, enforce it even for explicit requests
    if (allowedSet && !allowedSet.has(upper)) {
      log.warn(`[bash_exec] Secret "${key}" not in allowed keys — skipped`);
      continue;
    }
    // Find the actual key in user secrets (case-insensitive match)
    for (const [actualKey, value] of Object.entries(all)) {
      if (actualKey.toUpperCase() === upper) {
        result[actualKey] = value;
        break;
      }
    }
  }

  return result;
}

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
    mutating: (args: { command?: string }) => isMutatingCommand(args.command ?? ""),
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
      inject_secrets: z
        .array(z.string())
        .optional()
        .describe("Secret keys to inject as env vars for this command (e.g. [\"GH_TOKEN\"]). Only keys declared by skills are allowed."),
    },
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in seconds (default 120, max 600)" },
        cwd: { type: "string", description: "Working directory. Omit to use workspace root" },
        inject_secrets: {
          type: "array",
          items: { type: "string" },
          description: "Secret keys to inject as env vars for this command (e.g. [\"GH_TOKEN\"]). Only keys declared by skills are allowed.",
        },
      },
      required: ["command"],
    },
    execute: async (args: { command: string; timeout?: number; cwd?: string; inject_secrets?: string[] }, ctx: ToolContext) => {
      const userEnv = resolveSecrets(config, ctx.userId, args.inject_secrets);
      return runCommand(args, resolvedDefaultCwd, defaultTimeout, maxTimeout, maxOutput, config.allowedCommands, userEnv);
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
  userEnv?: Record<string, string>,
): Promise<string> {
  const { command } = args;

  // Allowlist check — pipes allowed, but each segment must start with an allowed command
  if (allowedCommands) {
    // Block dangerous metacharacters (command chaining, subshells, redirects)
    // Pipes (|) are allowed — each segment is checked individually below
    if (/[;&`$(){}<>]/.test(command)) {
      return `Error: Shell metacharacters (except pipe) are not allowed when command allowlist is active.`;
    }
    // Check every command in the pipeline
    const segments = command.split("|").map((s) => s.trim());
    for (const seg of segments) {
      const bin = seg.split(/\s/)[0];
      if (!allowedCommands.includes(bin)) {
        return `Error: Command "${bin}" is not allowed. Allowed: ${allowedCommands.join(", ")}`;
      }
    }
  }

  // Block commands that reference sensitive files (e.g. `cat .env`, `head /path/.env.local`)
  const tokens = command.split(/\s+/);
  if (tokens.some((t) => isSensitiveFile(t))) {
    return `Error: Access to sensitive files is not allowed.`;
  }

  let cwd = args.cwd ? resolve(args.cwd) : defaultCwd;

  // Fallback chain: args.cwd → defaultCwd → process.cwd()
  // spawn() throws ENOENT when cwd doesn't exist (not just when binary is missing)
  if (!existsSync(cwd)) {
    log.warn(`[bash_exec] cwd "${cwd}" does not exist, falling back to default: ${defaultCwd}`);
    cwd = defaultCwd;
  }
  if (!existsSync(cwd)) {
    log.warn(`[bash_exec] default cwd "${cwd}" also missing, falling back to process.cwd(): ${process.cwd()}`);
    cwd = process.cwd();
  }

  const timeoutMs = args.timeout
    ? Math.min(args.timeout * 1000, maxTimeout)
    : defaultTimeout;

  log.info(`[bash_exec] Running: ${command} (cwd=${cwd}, timeout=${timeoutMs}ms)`);

  try {
    const result = await execStreaming(command, { cwd, timeoutMs, maxOutput, userEnv });

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
    log.error(`[bash_exec] Error:`, err.message);
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
  opts: { cwd: string; timeoutMs: number; maxOutput: number; userEnv?: Record<string, string> },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: opts.cwd,
      env: { ...sanitizeEnv(process.env), TERM: "dumb", CUPS_SERVER: "", ...opts.userEnv },
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
