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
  /** Dynamic system prompt addition (user identity + memories) for native context providers. */
  systemPromptAddition?: string;
  abortSignal?: AbortSignal;
  /** Per-request context for tools that need user/session identity. */
  toolContext?: ToolContext;
};

export interface ChatProvider {
  readonly name: string;
  /** When true, the provider manages its own conversation context (e.g. Claude Agent SDK resume).
   *  handleConversation will skip history loading/compaction and pass context via systemPromptAddition. */
  readonly usesNativeContext?: boolean;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
  summarize?(messages: Array<{ role: string; content: string }>): Promise<string>;
}
