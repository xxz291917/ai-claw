import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatProvider, ChatEvent, ChatRequest } from "./types.js";
import { toolRequestContext } from "../tools/request-context.js";
import { log } from "../logger.js";

export type ClaudeProviderConfig = {
  workspaceDir: string;
  skillContent: string;
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

    log.info(`[claude] query() start — resume=${req.sessionId ?? "(new)"} maxTurns=${this.config.maxTurns ?? 30}`);

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
        mcpServers: this.config.mcpServers as any,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: this.config.maxTurns ?? 30,
        maxBudgetUsd: this.config.maxBudgetUsd ?? 2.0,
        includePartialMessages: true,
        persistSession: true,
        ...(req.sessionId ? { resume: req.sessionId } : {}),
        abortController,
        env: {
          ...process.env,
          ...(this.config.env ?? {}),
        },
      },
    });

    try {
      for await (const message of q) {
        const elapsed = Date.now() - t0;

        if (message.type === "stream_event") {
          const event = (message as any).event;
          // Log non-delta events for visibility
          if (event?.type && event.type !== "content_block_delta") {
            log.info(`[claude] stream_event: ${event.type} (${elapsed}ms)`);
          }
          if (event?.type === "content_block_delta" && event.delta?.text) {
            yield { type: "text", content: event.delta.text };
          }
        } else if (message.type === "tool_progress") {
          const msg = message as any;
          log.info(`[claude] tool_progress: ${msg.tool_name ?? "?"} elapsed=${msg.elapsed_time_seconds}s (${elapsed}ms)`);
          yield {
            type: "tool_use",
            tool: msg.tool_name ?? "unknown",
            input: { elapsed: msg.elapsed_time_seconds },
          };
        } else if (message.type === "result") {
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
        } else {
          // Log any other message types we haven't handled
          log.info(`[claude] message type=${message.type} (${elapsed}ms)`);
        }
      }
    } catch (err: any) {
      log.error(`[claude] stream error (${Date.now() - t0}ms):`, err.message ?? err);
      yield { type: "error", message: err.message ?? "Unknown error" };
      yield { type: "done", sessionId: "", costUsd: 0 };
    }
  }
}
