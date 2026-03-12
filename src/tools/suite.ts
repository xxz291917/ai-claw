/**
 * Shared tool suite builder — assembles unified tools, MCP server,
 * and prompt descriptions from environment config.
 *
 * Used by Chat Assistant setup.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { registerTools } from "./register.js";
import { createSentryQueryTool } from "./sentry-query.js";
import { createWebSearchTool } from "./web-search.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createBashExecTool } from "./bash-exec.js";
import { createClaudeCodeTool } from "./claude-code.js";
import { createFileTools } from "./file-tools.js";
import { createMemorySaveTool } from "./memory-save.js";
import { createMemoryDeleteTool } from "./memory-delete.js";
import { createMemoryListTool } from "./memory-list.js";
import { createSpawnTool } from "./spawn.js";
import { scanSkillDirs } from "../skills/loader.js";
import type { MemoryManager } from "../memory/manager.js";
import type { SubagentManager } from "../subagent/manager.js";
import type { UserSecretsManager } from "../secrets/manager.js";
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
  memoryManager?: MemoryManager,
  opts?: { subagentManager?: SubagentManager; defaultProvider?: string; extraTools?: UnifiedToolDef[]; secretsManager?: UserSecretsManager },
): ToolSuiteResult {
  const toolDefs: UnifiedToolDef[] = [
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
    // Collect allowed secret keys from eligible skills' `requires-env` declarations
    const allSkills = scanSkillDirs(skillsDirs);
    const allowedSecretKeys = [
      ...new Set(allSkills.filter((s) => s.eligibility.eligible).flatMap((s) => s.requirements.env)),
    ];

    toolDefs.push(
      createBashExecTool({
        defaultCwd: env.WORKSPACE_DIR,
        defaultTimeoutMs: (env.BASH_EXEC_TIMEOUT ?? 120) * 1000,
        maxTimeoutMs: (env.BASH_EXEC_MAX_TIMEOUT ?? 600) * 1000,
        allowedCommands: env.BASH_EXEC_ALLOWED_COMMANDS
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        secretsManager: opts?.secretsManager,
        allowedSecretKeys: allowedSecretKeys.length > 0 ? allowedSecretKeys : undefined,
      }),
    );
  }

  // Memory tools — registered statically, receive userId via ToolContext at runtime
  if (memoryManager) {
    toolDefs.push(
      createMemorySaveTool(memoryManager),
      createMemoryDeleteTool(memoryManager),
      createMemoryListTool(memoryManager),
    );
  }

  // Spawn tool — delegates to SubagentManager for background task execution
  if (opts?.subagentManager) {
    toolDefs.push(
      createSpawnTool(opts.subagentManager, opts.defaultProvider ?? "claude"),
    );
  }

  // Append bridged MCP tools
  if (opts?.extraTools) {
    toolDefs.push(...opts.extraTools);
  }

  const { mcpTools, genericTools, descriptions } = registerTools(toolDefs);

  const mcpServers = {
    "ai-claw-tools": createSdkMcpServer({
      name: "ai-claw-tools",
      tools: mcpTools,
    }),
  };

  return { mcpServers, genericTools, descriptions };
}
