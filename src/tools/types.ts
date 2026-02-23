import type { z } from "zod";

/**
 * Per-request context passed to tool execute() at invocation time.
 * Tools that need user identity read it from here instead of closures.
 */
export type ToolContext = {
  userId: string;
  sessionId: string;
};

/**
 * Unified tool definition — single source of truth for both providers.
 *
 * Each tool factory returns this shape. Registration utilities in register.ts
 * convert it to MCP (Agent SDK) and Generic (OpenAI) formats automatically.
 */
export type UnifiedToolDef = {
  name: string;
  description: string;
  /** Zod schema for MCP (Agent SDK) registration */
  inputSchema: Record<string, z.ZodType>;
  /** JSON Schema for Generic (OpenAI) registration */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Core logic — returns plain string. ctx provides per-request user/session info. */
  execute: (args: any, ctx: ToolContext) => Promise<string>;
};
