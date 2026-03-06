import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.js";

const mcpServerSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

const mcpConfigSchema = z.record(z.string(), mcpServerSchema);

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpConfig = Record<string, McpServerConfig>;

/** Parse and validate raw config object. */
export function parseMcpConfig(raw: unknown): McpConfig {
  return mcpConfigSchema.parse(raw);
}

/**
 * Load MCP server config from `mcp-servers.json` in the given directory.
 * Returns empty config if file does not exist.
 * Throws on malformed JSON or schema validation failure.
 */
export function loadMcpConfig(dir: string): McpConfig {
  const filePath = resolve(dir, "mcp-servers.json");
  if (!existsSync(filePath)) {
    log.info("[mcp] No mcp-servers.json found — no external MCP servers");
    return {};
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  return parseMcpConfig(raw);
}
