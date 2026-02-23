import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDef } from "../chat/generic-provider.js";
import type { UnifiedToolDef, ToolContext } from "./types.js";

/**
 * Convert a UnifiedToolDef into the three outputs needed:
 * 1. MCP tool (for Claude Agent SDK)
 * 2. Generic ToolDef (for OpenAI-compatible APIs)
 * 3. System prompt description string (auto-generated from parameters)
 *
 * ToolContext is threaded through at invocation time — tools that need
 * userId/sessionId read it from there.
 */
export function registerTool(def: UnifiedToolDef) {
  // MCP handler — ctx not available in MCP path (Claude Agent SDK manages its own context)
  const defaultCtx: ToolContext = { userId: "", sessionId: "" };
  const mcpHandler = async (args: any) => {
    const text = await def.execute(args, defaultCtx);
    const isError = text.startsWith("Error:");
    return {
      content: [{ type: "text" as const, text }],
      ...(isError && { isError: true }),
    };
  };

  return {
    mcp: tool(def.name, def.description, def.inputSchema, mcpHandler),
    generic: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      handler: def.execute,
    } satisfies ToolDef,
    description: autoDescription(def),
  };
}

/** Batch-register multiple tools. */
export function registerTools(defs: UnifiedToolDef[]) {
  const mcpTools: ReturnType<typeof tool<any>>[] = [];
  const genericTools: ToolDef[] = [];
  const descriptions: string[] = [];

  for (const def of defs) {
    const { mcp, generic, description } = registerTool(def);
    mcpTools.push(mcp);
    genericTools.push(generic);
    descriptions.push(description);
  }

  return { mcpTools, genericTools, descriptions };
}

/**
 * Auto-generate prompt description from tool definition.
 * Example: `bash_exec(command, timeout?, cwd?)` — Execute a shell command locally
 */
function autoDescription(def: UnifiedToolDef): string {
  const props = Object.keys(def.parameters.properties ?? {});
  const required = new Set(def.parameters.required ?? []);
  const args = props.map((p) => (required.has(p) ? p : `${p}?`)).join(", ");
  const summary = def.description.split(". ")[0];
  return `\`${def.name}(${args})\` — ${summary}`;
}
