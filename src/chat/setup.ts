/**
 * Chat provider setup — builds system prompt, provider registry, and
 * creates the active provider instance.
 *
 * Tool assembly is delegated to the shared buildToolSuite() so that
 * both Chat and Fault Healing share the same tool infrastructure.
 */

import { buildToolSuite, type ToolSuiteEnv, type ToolSuiteResult } from "../tools/suite.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildDefaultRegistry, type ProviderRegistry } from "./provider-registry.js";
import type { ChatProvider } from "./types.js";
import type { MemoryManager } from "../memory/manager.js";

export type ChatSetupEnv = ToolSuiteEnv & {
  CHAT_PROVIDER?: string;
  CHAT_API_BASE?: string;
  CHAT_API_KEY?: string;
  CHAT_MODEL?: string;
  CHAT_MAX_TOOL_RESULT_CHARS?: number;
  CHAT_MAX_CONTEXT_TOKENS?: number;
  CHAT_FETCH_TIMEOUT?: number;
};

export type ChatSetupResult = {
  provider: ChatProvider;
  registry: ProviderRegistry;
  mcpServers: Record<string, unknown>;
  systemPrompt: string;
};

export function setupChatProvider(
  env: ChatSetupEnv,
  skillsDirs: string[],
  existingSuite?: ToolSuiteResult,
  memoryManager?: MemoryManager,
  claudeServerConfigs?: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>,
): ChatSetupResult {
  const suite = existingSuite ?? buildToolSuite(env, skillsDirs, memoryManager);

  const mergedMcpServers = {
    ...suite.mcpServers,
    ...(claudeServerConfigs ?? {}),
  };

  const providerName = env.CHAT_PROVIDER ?? "claude";

  // GenericProvider gets structured tool definitions via the API `tools` parameter,
  // so we OMIT tool descriptions from the system prompt to avoid duplication.
  // Duplicate tool listings cause some models (e.g. DeepSeek) to "roleplay" tool calls
  // in text (fake XML tags) instead of using the function calling API properly.
  // Simple heuristic: only include tool descriptions for the "claude" provider.
  const includeToolDescs = providerName === "claude";

  const promptBase = {
    workspaceDir: env.WORKSPACE_DIR,
    skillsDirs,
    tools: includeToolDescs ? suite.descriptions : undefined,
  };

  const systemPrompt = buildSystemPrompt({ ...promptBase, mode: "full" });
  const minimalPrompt = buildSystemPrompt({ ...promptBase, mode: "minimal" });

  // Build the registry with all available providers
  const registry = buildDefaultRegistry(
    env as unknown as Record<string, string | undefined>,
    {
      systemPrompt,
      minimalPrompt,
      skillsDirs,
      mcpServers: mergedMcpServers,
      genericTools: suite.genericTools,
    },
  );

  // Create the selected provider
  const provider = registry.create(providerName);

  return { provider, registry, mcpServers: mergedMcpServers, systemPrompt };
}
