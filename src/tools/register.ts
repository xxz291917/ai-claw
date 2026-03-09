import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDef } from "../chat/generic-provider.js";
import type { UnifiedToolDef, ToolContext } from "./types.js";
import { toolRequestContext } from "./request-context.js";

/**
 * Convert a UnifiedToolDef into the three outputs needed:
 * 1. MCP tool (for Claude Agent SDK)
 * 2. Generic ToolDef (for OpenAI-compatible APIs)
 * 3. System prompt description string (auto-generated from parameters)
 *
 * ToolContext is threaded through at invocation time — tools that need
 * userId/sessionId read it from there.
 */

/**
 * Check if a tool call requires user confirmation based on the tool's
 * `mutating` flag and the current ToolContext.
 * Returns a confirmation message if blocked, or null if execution can proceed.
 */
function checkConfirmation(def: UnifiedToolDef, args: any, ctx: ToolContext): string | null {
  if (ctx.skipConfirmation) return null;
  if (!def.mutating) return null;
  const isMutating = typeof def.mutating === "function" ? def.mutating(args) : def.mutating;
  if (!isMutating) return null;

  const summary = JSON.stringify(args).slice(0, 200);
  return `[CONFIRMATION_REQUIRED] 该操作需要用户确认。工具: ${def.name}, 参数: ${summary}\n\n请回复 "确认" 或 "直接执行" 以继续。`;
}

/**
 * Create the MCP-compatible handler for a UnifiedToolDef.
 * Reads ToolContext from AsyncLocalStorage (set by ClaudeProvider.stream() via enterWith).
 */
export function createMcpHandler(def: UnifiedToolDef) {
  return async (args: any) => {
    const ctx = toolRequestContext.getStore() ?? { userId: "", sessionId: "" };

    // Confirmation gate for mutating tools
    const blocked = checkConfirmation(def, args, ctx);
    if (blocked) {
      return { content: [{ type: "text" as const, text: blocked }], isError: true };
    }

    const text = await def.execute(args, ctx);
    const isError = text.startsWith("Error:");
    return {
      content: [{ type: "text" as const, text }],
      ...(isError && { isError: true }),
    };
  };
}

export function registerTool(def: UnifiedToolDef) {
  const mcpHandler = createMcpHandler(def);

  return {
    mcp: tool(def.name, def.description, def.inputSchema, mcpHandler),
    generic: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      handler: async (args: any, ctx: ToolContext) => {
        const blocked = checkConfirmation(def, args, ctx);
        if (blocked) return blocked;
        return def.execute(args, ctx);
      },
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
