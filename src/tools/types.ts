import type { z } from "zod";

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
  /** Core logic — returns plain string. Both MCP and Generic handlers derive from this. */
  execute: (args: any) => Promise<string>;
};
