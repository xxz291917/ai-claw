import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatProvider, ChatEvent, ChatRequest } from "./types.js";

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

  constructor(private config: ClaudeProviderConfig) {}

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const t0 = Date.now();
    const abortController = new AbortController();

    // Abort SDK query when client disconnects
    if (req.abortSignal) {
      req.abortSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    console.log(`[claude] query() start — resume=${req.sessionId ?? "(new)"} maxTurns=${this.config.maxTurns ?? 30}`);

    const q = query({
      prompt: req.message,
      options: {
        cwd: this.config.workspaceDir,
        systemPrompt: this.config.skillContent,
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
            console.log(`[claude] stream_event: ${event.type} (${elapsed}ms)`);
          }
          if (event?.type === "content_block_delta" && event.delta?.text) {
            yield { type: "text", content: event.delta.text };
          }
        } else if (message.type === "tool_progress") {
          const msg = message as any;
          console.log(`[claude] tool_progress: ${msg.tool_name ?? "?"} elapsed=${msg.elapsed_time_seconds}s (${elapsed}ms)`);
          yield {
            type: "tool_use",
            tool: msg.tool_name ?? "unknown",
            input: { elapsed: msg.elapsed_time_seconds },
          };
        } else if (message.type === "result") {
          const msg = message as any;
          console.log(`[claude] result: subtype=${msg.subtype} cost=$${msg.total_cost_usd ?? 0} (${elapsed}ms)`);
          if (msg.subtype === "success") {
            yield {
              type: "done",
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd ?? 0,
            };
          } else {
            console.error(`[claude] agent failed:`, msg.errors);
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
          console.log(`[claude] message type=${message.type} (${elapsed}ms)`);
        }
      }
    } catch (err: any) {
      console.error(`[claude] stream error (${Date.now() - t0}ms):`, err.message ?? err);
      yield { type: "error", message: err.message ?? "Unknown error" };
      yield { type: "done", sessionId: "", costUsd: 0 };
    }
  }
}
