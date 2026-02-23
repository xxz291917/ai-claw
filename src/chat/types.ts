/**
 * Provider-agnostic chat interface.
 * ClaudeProvider uses Agent SDK; GenericProvider uses OpenAI-compatible API.
 */

import type { ToolContext } from "../tools/types.js";

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; costUsd: number };

export type ChatRequest = {
  message: string;
  sessionId?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  abortSignal?: AbortSignal;
  /** Per-request context for tools that need user/session identity. */
  toolContext?: ToolContext;
};

export interface ChatProvider {
  readonly name: string;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
  summarize?(messages: Array<{ role: string; content: string }>): Promise<string>;
}
