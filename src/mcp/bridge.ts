import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "../logger.js";
import type { McpConfig, McpServerConfig } from "./config.js";
import type { UnifiedToolDef, ToolContext } from "../tools/types.js";
import { z } from "zod";

const CONNECT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
const CALL_TOOL_TIMEOUT_MS = 30_000;

export type McpBridgeResult = {
  /** UnifiedToolDef[] for GenericProvider (bridged tools) */
  tools: UnifiedToolDef[];
  /** SSE configs for ClaudeProvider's native mcpServers */
  claudeServerConfigs: Record<string, { url: string; headers?: Record<string, string> }>;
  /** Successfully connected server names */
  connected: { name: string; toolCount: number }[];
  /** Skipped server names with reasons */
  skipped: { name: string; reason: string }[];
};

/**
 * Connect to all configured MCP servers, list their tools, and produce
 * both UnifiedToolDef[] (for GenericProvider) and native configs (for ClaudeProvider).
 *
 * Servers that fail to connect are skipped with a warning.
 */
export async function bridgeMcpTools(config: McpConfig): Promise<McpBridgeResult> {
  const tools: UnifiedToolDef[] = [];
  const claudeServerConfigs: McpBridgeResult["claudeServerConfigs"] = {};
  const connected: McpBridgeResult["connected"] = [];
  const skipped: McpBridgeResult["skipped"] = [];

  const entries = Object.entries(config);
  if (entries.length === 0) return { tools, claudeServerConfigs, connected, skipped };

  for (const [serverName, serverConfig] of entries) {
    try {
      const { client, serverTools } = await connectAndListTools(serverName, serverConfig);

      // Build UnifiedToolDef for each tool (GenericProvider path)
      for (const mcpTool of serverTools) {
        tools.push(mcpToolToUnified(serverName, mcpTool, client));
      }

      // Store native config for ClaudeProvider path
      claudeServerConfigs[serverName] = {
        url: serverConfig.url,
        ...(Object.keys(serverConfig.headers).length > 0 && { headers: serverConfig.headers }),
      };

      connected.push({ name: serverName, toolCount: serverTools.length });
      log.info(`[mcp] Connected to ${serverName} — ${serverTools.length} tool(s)`);
    } catch (err: any) {
      const reason = err.message ?? String(err);
      skipped.push({ name: serverName, reason });
      log.warn(`[mcp] Skipped ${serverName}: ${reason}`);
    }
  }

  return { tools, claudeServerConfigs, connected, skipped };
}

type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, object>; required?: string[] };
};

async function connectAndListTools(
  serverName: string,
  config: McpServerConfig,
): Promise<{ client: Client; serverTools: McpToolInfo[] }> {
  const url = new URL(config.url);
  const hasHeaders = Object.keys(config.headers).length > 0;

  // Try Streamable HTTP first (modern), fall back to SSE (legacy).
  // Each attempt needs a fresh Client since connect() can only be called once.
  try {
    const client = new Client({ name: "ai-claw", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: hasHeaders ? { headers: config.headers } : undefined,
    });
    await connectWithTimeout(client, transport, PROBE_TIMEOUT_MS);
    log.info(`[mcp] ${serverName}: connected via Streamable HTTP`);
    const result = await client.listTools();
    return { client, serverTools: result.tools as McpToolInfo[] };
  } catch {
    const client = new Client({ name: "ai-claw", version: "1.0.0" });
    const transport = new SSEClientTransport(url, {
      eventSourceInit: {
        fetch: (reqUrl: string | URL | Request, init?: RequestInit) =>
          fetch(reqUrl, {
            ...init,
            headers: { ...(init?.headers as Record<string, string>), ...config.headers },
          }),
      },
    });
    await connectWithTimeout(client, transport);
    log.info(`[mcp] ${serverName}: connected via SSE (fallback)`);
    const result = await client.listTools();
    return { client, serverTools: result.tools as McpToolInfo[] };
  }
}

async function connectWithTimeout(
  client: Client,
  transport: SSEClientTransport | StreamableHTTPClientTransport,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<void> {
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Connection timeout")), timeoutMs),
  );
  await Promise.race([connectPromise, timeoutPromise]);
}

/**
 * Convert a single MCP tool into a UnifiedToolDef.
 * The execute() function proxies to the MCP client's callTool().
 */
function mcpToolToUnified(serverName: string, mcpTool: McpToolInfo, client: Client): UnifiedToolDef {
  const prefixedName = `${serverName}__${mcpTool.name}`;
  const description = mcpTool.description ?? `${serverName} tool: ${mcpTool.name}`;

  // Build Zod inputSchema from JSON Schema properties
  const zodProps: Record<string, z.ZodType> = {};
  const props = mcpTool.inputSchema?.properties ?? {};
  const required = new Set(mcpTool.inputSchema?.required ?? []);
  for (const [key] of Object.entries(props)) {
    // Use z.any() as a pass-through — the MCP server validates its own inputs.
    zodProps[key] = required.has(key) ? z.any() : z.any().optional();
  }

  return {
    name: prefixedName,
    description,
    inputSchema: zodProps,
    parameters: {
      type: "object" as const,
      properties: (mcpTool.inputSchema?.properties as Record<string, unknown>) ?? {},
      ...(mcpTool.inputSchema?.required ? { required: mcpTool.inputSchema.required as string[] } : {}),
    },
    execute: async (args: any, _ctx: ToolContext) => {
      try {
        const callPromise = client.callTool({ name: mcpTool.name, arguments: args });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool call timeout (${CALL_TOOL_TIMEOUT_MS / 1000}s)`)), CALL_TOOL_TIMEOUT_MS),
        );
        const result = await Promise.race([callPromise, timeoutPromise]);
        // Extract text content from MCP result
        const content = (result as any).content;
        if (Array.isArray(content)) {
          return content
            .map((c: any) => {
              if (c.type === "text") return c.text;
              if (c.type === "image") return `[image: ${c.mimeType}]`;
              return JSON.stringify(c);
            })
            .join("\n");
        }
        return JSON.stringify(result);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}
