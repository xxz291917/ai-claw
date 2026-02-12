import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { createSentryQueryTool } from "./tools/sentry-query.js";

export type AgentConfig = {
  workspaceDir: string;
  sentryConfig: { authToken: string; org: string; project: string };
  skillContent: string;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
};

export type AgentResult = {
  text: string;
  sessionId: string;
  costUsd: number;
  error?: string;
};

/**
 * Build Claude Agent SDK options. Exported for testing.
 */
export function buildAgentOptions(config: AgentConfig) {
  const sentryTool = createSentryQueryTool(config.sentryConfig);

  // Create in-process MCP server with custom tools
  const mcpServer = createSdkMcpServer({
    name: "ai-hub-tools",
    tools: [
      tool(
        sentryTool.name,
        sentryTool.description,
        sentryTool.inputSchema,
        sentryTool.handler,
      ),
    ],
  });

  return {
    cwd: config.workspaceDir,
    systemPrompt: config.skillContent,
    tools: { type: "preset" as const, preset: "claude_code" as const },
    mcpServers: {
      "ai-hub-tools": mcpServer,
    },
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    maxTurns: 30,
    maxBudgetUsd: config.maxBudgetUsd ?? 2.0,
    env: {
      ...process.env,
      ...(config.env ?? {}),
    },
  };
}

/**
 * Run the Claude agent with a prompt.
 * Returns the final text result and metadata.
 */
export async function runAgent(
  prompt: string,
  config: AgentConfig,
  opts?: { abortSignal?: AbortSignal },
): Promise<AgentResult> {
  const options = buildAgentOptions(config);

  const abortController = new AbortController();
  if (opts?.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => abortController.abort());
  }

  const q = query({
    prompt,
    options: {
      ...options,
      abortController,
    },
  });

  let resultText = "";
  let sessionId = "";
  let costUsd = 0;
  let error: string | undefined;

  for await (const message of q) {
    if (message.type === "result") {
      sessionId = message.session_id;
      costUsd = message.total_cost_usd;
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        error = message.errors?.join("; ") ?? "Agent run failed";
      }
    }
  }

  return { text: resultText, sessionId, costUsd, error };
}
