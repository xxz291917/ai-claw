import { query } from "@anthropic-ai/claude-agent-sdk";

export type AgentResult = {
  text: string;
  sessionId: string;
  costUsd: number;
  error?: string;
};

export type BatchAgentConfig = {
  workspaceDir: string;
  systemPrompt: string;
  mcpServers: Record<string, unknown>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
};

/**
 * Run the Claude agent in batch mode (collect final result).
 * Used by the Fault Healing workflow.
 */
export async function runAgent(
  prompt: string,
  config: BatchAgentConfig,
  opts?: { abortSignal?: AbortSignal },
): Promise<AgentResult> {
  const abortController = new AbortController();
  if (opts?.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => abortController.abort());
  }

  const q = query({
    prompt,
    options: {
      cwd: config.workspaceDir,
      systemPrompt: config.systemPrompt,
      tools: { type: "preset" as const, preset: "claude_code" as const },
      mcpServers: config.mcpServers as any,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      maxTurns: config.maxTurns ?? 30,
      maxBudgetUsd: config.maxBudgetUsd ?? 2.0,
      abortController,
      env: {
        ...process.env,
        ...(config.env ?? {}),
      },
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
