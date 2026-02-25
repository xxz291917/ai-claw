import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolContext } from "./types.js";

/**
 * Per-request ToolContext storage for MCP tool handlers.
 *
 * MCP handlers are registered statically but need per-request userId/sessionId.
 * ClaudeProvider calls enterWith() at the start of each stream() invocation so
 * all MCP tool calls within that stream inherit the correct context.
 */
export const toolRequestContext = new AsyncLocalStorage<ToolContext>();
