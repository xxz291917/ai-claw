/**
 * Provider-agnostic chat interface.
 * ClaudeProvider uses Agent SDK; GenericProvider uses OpenAI-compatible API.
 */

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; costUsd: number };

/** Lightweight tool definition for per-request tools injected by the router. */
export type RequestTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: any) => Promise<string>;
};

export type ChatRequest = {
  message: string;
  sessionId?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  abortSignal?: AbortSignal;
  /** Per-request tools (e.g. memory_save with userId baked in). Merged with static tools. */
  requestTools?: RequestTool[];
};

export interface ChatProvider {
  readonly name: string;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
  summarize?(messages: Array<{ role: string; content: string }>): Promise<string>;
}
