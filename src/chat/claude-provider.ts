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
    const abortController = new AbortController();

    // Abort SDK query when client disconnects
    if (req.abortSignal) {
      req.abortSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

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
        if (message.type === "stream_event") {
          const event = (message as any).event;
          if (event?.type === "content_block_delta" && event.delta?.text) {
            yield { type: "text", content: event.delta.text };
          }
        } else if (message.type === "tool_progress") {
          const msg = message as any;
          yield {
            type: "tool_use",
            tool: msg.tool_name ?? "unknown",
            input: { elapsed: msg.elapsed_time_seconds },
          };
        } else if (message.type === "result") {
          const msg = message as any;
          if (msg.subtype === "success") {
            yield {
              type: "done",
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd ?? 0,
            };
          } else {
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
    } catch (err: any) {
      yield { type: "error", message: err.message ?? "Unknown error" };
      yield { type: "done", sessionId: "", costUsd: 0 };
    }
  }
}
