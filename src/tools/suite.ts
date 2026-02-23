/**
 * Shared tool suite builder — assembles unified tools, MCP server,
 * and prompt descriptions from environment config.
 *
 * Used by Chat Assistant setup.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { registerTools } from "./register.js";
import { createSkillReaderTool } from "./skill-reader.js";
import { createSentryQueryTool } from "./sentry-query.js";
import { createWebSearchTool } from "./web-search.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createBashExecTool } from "./bash-exec.js";
import { createClaudeCodeTool } from "./claude-code.js";
import { createFileTools } from "./file-tools.js";
import type { ToolDef } from "../chat/generic-provider.js";
import type { UnifiedToolDef } from "./types.js";

export type ToolSuiteEnv = {
  WORKSPACE_DIR: string;
  SENTRY_BASE_URL?: string;
  SENTRY_AUTH_TOKEN?: string;
  SENTRY_ORG?: string;
  SENTRY_PROJECT?: string;
  BRAVE_API_KEY?: string;
  FIRECRAWL_API_KEY?: string;
  BASH_EXEC_ENABLED?: string;
  BASH_EXEC_TIMEOUT?: number;
  BASH_EXEC_MAX_TIMEOUT?: number;
  BASH_EXEC_ALLOWED_COMMANDS?: string;
};

export type ToolSuiteResult = {
  mcpServers: Record<string, unknown>;
  genericTools: ToolDef[];
  descriptions: string[];
};

/**
 * Build the full tool suite from environment config.
 * Returns MCP servers, generic tool defs, and prompt descriptions.
 */
export function buildToolSuite(
  env: ToolSuiteEnv,
  skillsDirs: string[],
): ToolSuiteResult {
  const toolDefs: UnifiedToolDef[] = [
    createSkillReaderTool(skillsDirs),
    createWebFetchTool({ firecrawlApiKey: env.FIRECRAWL_API_KEY }),
    createClaudeCodeTool({ workspaceDir: env.WORKSPACE_DIR }),
    ...createFileTools({ workspaceDir: env.WORKSPACE_DIR }),
  ];

  if (env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT) {
    toolDefs.push(
      createSentryQueryTool({
        baseUrl: env.SENTRY_BASE_URL,
        authToken: env.SENTRY_AUTH_TOKEN,
        org: env.SENTRY_ORG,
        project: env.SENTRY_PROJECT,
      }),
    );
  }

  if (env.BRAVE_API_KEY) {
    toolDefs.push(createWebSearchTool({ apiKey: env.BRAVE_API_KEY }));
  }

  if (env.BASH_EXEC_ENABLED === "true") {
    toolDefs.push(
      createBashExecTool({
        defaultCwd: env.WORKSPACE_DIR,
        defaultTimeoutMs: (env.BASH_EXEC_TIMEOUT ?? 120) * 1000,
        maxTimeoutMs: (env.BASH_EXEC_MAX_TIMEOUT ?? 600) * 1000,
        allowedCommands: env.BASH_EXEC_ALLOWED_COMMANDS
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    );
  }

  const { mcpTools, genericTools, descriptions } = registerTools(toolDefs);

  const mcpServers = {
    "ai-hub-tools": createSdkMcpServer({
      name: "ai-hub-tools",
      tools: mcpTools,
    }),
  };

  return { mcpServers, genericTools, descriptions };
}
