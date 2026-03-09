/**
 * Claude Agent SDK provider — wraps the SDK's query() to spawn Claude CLI
 * as a subprocess.
 *
 * ## Known pitfalls (2026-03-08)
 *
 * The SDK spawns `node cli.js` as a child process. Two environment issues
 * can cause it to fail silently or with misleading errors:
 *
 * 1. **Cannot run as root** — Claude CLI refuses `--allow-dangerously-skip-permissions`
 *    under root/sudo for security reasons (exits with code 1). The service must
 *    run as a non-root user (e.g. via PM2 `uid` option).
 *
 * 2. **PM2 uid switch doesn't update HOME/USER env vars** — PM2 changes the
 *    process uid but leaves `process.env.HOME` pointing to `/root`. The CLI
 *    then tries to write `~/.claude.json` to `/root/` and gets EACCES, causing
 *    it to hang indefinitely with no output. Fix: use `os.userInfo()` (reads
 *    /etc/passwd by actual uid) to set correct HOME/USER in the subprocess env.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
// userInfo() reads user info from /etc/passwd based on actual process uid,
// unlike os.homedir() which just reads process.env.HOME. See pitfall #2 above.
import { userInfo } from "node:os";
import type { ChatProvider, ChatEvent, ChatRequest } from "./types.js";
import { toolRequestContext } from "../tools/request-context.js";
import { log } from "../logger.js";

export type ClaudeProviderConfig = {
  workspaceDir: string;
  skillContent: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
  mcpServers?: Record<string, unknown>;
};

export class ClaudeProvider implements ChatProvider {
  readonly name = "claude";
  readonly usesNativeContext = true;

  constructor(private config: ClaudeProviderConfig) {}

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const t0 = Date.now();

    // Propagate per-request ToolContext to MCP handlers via AsyncLocalStorage.
    // enterWith() is safe here: each HTTP request runs in an isolated async context
    // tree created by Node.js's HTTP server, so concurrent requests never share state.
    toolRequestContext.enterWith(req.toolContext ?? { userId: "", sessionId: "" });

    const abortController = new AbortController();

    // Abort SDK query when client disconnects
    if (req.abortSignal) {
      req.abortSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    log.info(`[claude] query() start — model=${this.config.model ?? "(default)"} resume=${req.sessionId ?? "(new)"}`);

    // handleConversation() always supplies systemPromptAddition (user identity + memories).
    const systemPrompt = req.systemPromptAddition
      ? `${this.config.skillContent}\n\n${req.systemPromptAddition}`
      : this.config.skillContent;

    const q = query({
      prompt: req.message,
      options: {
        cwd: this.config.workspaceDir,
        systemPrompt,
        tools: { type: "preset", preset: "claude_code" },
        ...(this.config.model ? { model: this.config.model } : {}),
        mcpServers: this.config.mcpServers as any,
        permissionMode: "bypassPermissions",       // NOTE: requires non-root user (see pitfall #1)
        allowDangerouslySkipPermissions: true,
        ...(this.config.maxTurns != null ? { maxTurns: this.config.maxTurns } : {}),
        ...(this.config.maxBudgetUsd != null ? { maxBudgetUsd: this.config.maxBudgetUsd } : {}),
        includePartialMessages: true,
        persistSession: true,
        ...(req.sessionId ? { resume: req.sessionId } : {}),
        abortController,
        stderr: (data: string) => log.warn(`[claude] stderr: ${data.trimEnd()}`),
        env: (() => {
          // Strip all Claude/subagent env vars so the spawned CLI
          // runs as a fresh top-level process, not in nested subagent mode.
          const merged = { ...process.env, ...(this.config.env ?? {}) };
          for (const key of Object.keys(merged)) {
            if (key === "CLAUDECODE" || (key.startsWith("CLAUDE_") && key !== "CLAUDE_CODE_OAUTH_TOKEN")) {
              delete merged[key];
            }
          }
          // Ensure HOME is writable by the current uid (PM2 uid switch
          // leaves HOME=/root which the non-root user can't write to).
          // userInfo() reads from /etc/passwd based on actual uid, not env.
          try {
            const info = userInfo();
            if (info.homedir) merged.HOME = info.homedir;
            if (info.username) merged.USER = info.username;
          } catch { /* best-effort */ }
          return merged;
        })(),
      },
    });

    try {
      let gotResult = false;

      for await (const message of q) {
        const elapsed = Date.now() - t0;

        if (message.type === "stream_event") {
          const event = (message as any).event;
          if (event?.type === "content_block_delta" && event.delta?.text) {
            yield { type: "text", content: event.delta.text };
          }
        } else if (message.type === "tool_progress") {
          const msg = message as any;
          log.info(`[claude] tool: ${msg.tool_name ?? "?"} (${msg.elapsed_time_seconds}s, ${elapsed}ms)`);
          yield {
            type: "tool_use",
            tool: msg.tool_name ?? "unknown",
            input: { elapsed: msg.elapsed_time_seconds },
          };
        } else if (message.type === "result") {
          gotResult = true;
          const msg = message as any;
          log.info(`[claude] result: subtype=${msg.subtype} cost=$${msg.total_cost_usd ?? 0} (${elapsed}ms)`);
          if (msg.subtype === "success") {
            yield {
              type: "done",
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd ?? 0,
            };
          } else {
            log.error(`[claude] agent failed:`, msg.errors);
            yield {
              type: "error",
              message: msg.errors?.join("; ") ?? "Agent run failed",
            };
            yield {
              type: "done",
              sessionId: msg.session_id ?? "",
              costUsd: msg.total_cost_usd ?? 0,
            };
          }
        }
      }
      // If the SDK loop ended without a result event, the auth token is likely
      // invalid or expired (the SDK silently returns an empty iterator in that case).
      if (!gotResult) {
        log.error(`[claude] query() ended with no result — auth token may be invalid or expired (${Date.now() - t0}ms)`);
        yield { type: "error", message: "Claude 认证失败，请检查 ANTHROPIC_API_KEY 或 CLAUDE_CODE_OAUTH_TOKEN 是否有效。" };
        yield { type: "done", sessionId: "", costUsd: 0 };
      }
    } catch (err: any) {
      log.error(`[claude] stream error (${Date.now() - t0}ms):`, err.message ?? err);
      yield { type: "error", message: err.message ?? "Unknown error" };
      yield { type: "done", sessionId: "", costUsd: 0 };
    }
  }
}
