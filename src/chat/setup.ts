/**
 * Chat provider setup — builds system prompt and provider instance.
 *
 * Tool assembly is delegated to the shared buildToolSuite() so that
 * both Chat and Fault Healing share the same tool infrastructure.
 */

import { buildToolSuite, type ToolSuiteEnv, type ToolSuiteResult } from "../tools/suite.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { ClaudeProvider } from "./claude-provider.js";
import { GenericProvider } from "./generic-provider.js";
import type { ChatProvider } from "./types.js";
import type { MemoryManager } from "../memory/manager.js";
import { scanSkillDirs, filterEligibleSkills } from "../skills/loader.js";

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
  mcpServers: Record<string, unknown>;
};

export function setupChatProvider(
  env: ChatSetupEnv,
  skillsDirs: string[],
  existingSuite?: ToolSuiteResult,
  memoryManager?: MemoryManager,
): ChatSetupResult {
  const suite = existingSuite ?? buildToolSuite(env, skillsDirs, memoryManager);

  // --- Create provider ---
  const isGeneric = env.CHAT_PROVIDER === "generic" && !!env.CHAT_API_BASE && !!env.CHAT_API_KEY;

  // GenericProvider gets structured tool definitions via the API `tools` parameter,
  // so we OMIT tool descriptions from the system prompt to avoid duplication.
  // Duplicate tool listings cause some models (e.g. DeepSeek) to "roleplay" tool calls
  // in text (fake XML tags) instead of using the function calling API properly.
  const systemPrompt = buildSystemPrompt({
    workspaceDir: env.WORKSPACE_DIR,
    skillsDirs,
    tools: isGeneric ? undefined : suite.descriptions,
  });

  let provider: ChatProvider;
  if (isGeneric) {
    provider = new GenericProvider({
      baseUrl: env.CHAT_API_BASE!,
      apiKey: env.CHAT_API_KEY!,
      model: env.CHAT_MODEL ?? "deepseek-chat",
      systemPrompt,
      tools: suite.genericTools,
      maxToolResultChars: env.CHAT_MAX_TOOL_RESULT_CHARS,
      maxContextTokens: env.CHAT_MAX_CONTEXT_TOKENS,
      fetchTimeout: env.CHAT_FETCH_TIMEOUT,
    });
  } else {
    provider = new ClaudeProvider({
      workspaceDir: env.WORKSPACE_DIR,
      skillContent: systemPrompt,
      env: collectSkillEnv(skillsDirs),
      mcpServers: suite.mcpServers,
    });
  }

  return { provider, mcpServers: suite.mcpServers };
}

/**
 * Collect env vars required by eligible skills from process.env.
 * Used to forward skill-specific API keys to ClaudeProvider's subprocess.
 */
function collectSkillEnv(skillsDirs: string[]): Record<string, string> {
  const skills = filterEligibleSkills(scanSkillDirs(skillsDirs));
  const env: Record<string, string> = {};
  for (const skill of skills) {
    for (const key of skill.requirements.env) {
      const value = process.env[key];
      if (value && !env[key]) {
        env[key] = value;
      }
    }
  }
  return env;
}
