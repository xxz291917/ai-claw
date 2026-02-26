import type { ChatProvider } from "./types.js";
import type { ToolDef } from "./generic-provider.js";
import { ClaudeProvider } from "./claude-provider.js";
import { GenericProvider } from "./generic-provider.js";
import { scanSkillDirs, filterEligibleSkills } from "../skills/loader.js";

export type ProviderEnvConfig = {
  name: string;
  apiBase: string;
  apiKey: string;
  model?: string;
  maxToolResultChars?: number;
  maxContextTokens?: number;
  fetchTimeout?: number;
};

export function scanProviderEnvVars(
  env: Record<string, string | undefined>,
): ProviderEnvConfig[] {
  const providers = new Map<string, Partial<ProviderEnvConfig>>();
  const prefix = "PROVIDER_";

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || !value) continue;

    const rest = key.slice(prefix.length);
    const underscoreIdx = rest.indexOf("_");
    if (underscoreIdx < 0) continue;

    const name = rest.slice(0, underscoreIdx).toLowerCase();
    const field = rest.slice(underscoreIdx + 1);

    if (!providers.has(name)) providers.set(name, { name });
    const config = providers.get(name)!;

    switch (field) {
      case "API_BASE": config.apiBase = value; break;
      case "API_KEY": config.apiKey = value; break;
      case "MODEL": config.model = value; break;
      case "MAX_TOOL_RESULT_CHARS": config.maxToolResultChars = Number(value); break;
      case "MAX_CONTEXT_TOKENS": config.maxContextTokens = Number(value); break;
      case "FETCH_TIMEOUT": config.fetchTimeout = Number(value); break;
    }
  }

  return [...providers.values()].filter(
    (c): c is ProviderEnvConfig => !!c.apiBase && !!c.apiKey,
  );
}

export type ProviderFactory = (opts?: Record<string, unknown>) => ChatProvider;

export type ProviderSpec = {
  name: string;
  type: "claude" | "openai-compatible";
  factory: ProviderFactory;
};

export class ProviderRegistry {
  private specs = new Map<string, ProviderSpec>();

  register(spec: ProviderSpec): void {
    this.specs.set(spec.name, spec);
  }

  create(name: string, opts?: Record<string, unknown>): ChatProvider {
    const spec = this.specs.get(name);
    if (!spec) {
      throw new Error(
        `Provider "${name}" not registered. Available: ${[...this.specs.keys()].join(", ")}`,
      );
    }
    return spec.factory(opts);
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  getSpec(name: string): ProviderSpec | undefined {
    return this.specs.get(name);
  }

  list(): ProviderSpec[] {
    return [...this.specs.values()];
  }
}

// ---------------------------------------------------------------------------
// Default registry builder
// ---------------------------------------------------------------------------

export type BuildRegistryOpts = {
  systemPrompt: string;
  skillsDirs: string[];
  mcpServers: Record<string, unknown>;
  genericTools?: ToolDef[];
};

/**
 * Build the default ProviderRegistry:
 * 1. Always registers "claude" (lazy — only fails at create time if key missing)
 * 2. Auto-registers providers from PROVIDER_{NAME}_* env vars
 * 3. Backwards compat: CHAT_API_BASE + CHAT_API_KEY → registers as "generic"
 */
export function buildDefaultRegistry(
  env: Record<string, string | undefined>,
  opts: BuildRegistryOpts,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Always register claude
  registry.register({
    name: "claude",
    type: "claude",
    factory: () => {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is required for claude provider");
      }
      return new ClaudeProvider({
        workspaceDir: env.WORKSPACE_DIR ?? ".",
        skillContent: opts.systemPrompt,
        env: collectSkillEnv(opts.skillsDirs),
        mcpServers: opts.mcpServers,
      });
    },
  });

  // Auto-register from PROVIDER_{NAME}_* env vars
  for (const config of scanProviderEnvVars(env)) {
    registry.register({
      name: config.name,
      type: "openai-compatible",
      factory: () =>
        new GenericProvider({
          baseUrl: config.apiBase,
          apiKey: config.apiKey,
          model: config.model ?? config.name,
          systemPrompt: opts.systemPrompt,
          tools: opts.genericTools,
          maxToolResultChars: config.maxToolResultChars,
          maxContextTokens: config.maxContextTokens,
          fetchTimeout: config.fetchTimeout,
        }),
    });
  }

  // Backwards compat: legacy CHAT_API_BASE + CHAT_API_KEY → register as "generic"
  if (env.CHAT_API_BASE && env.CHAT_API_KEY && !registry.has("generic")) {
    registry.register({
      name: "generic",
      type: "openai-compatible",
      factory: () =>
        new GenericProvider({
          baseUrl: env.CHAT_API_BASE!,
          apiKey: env.CHAT_API_KEY!,
          model: env.CHAT_MODEL ?? "deepseek-chat",
          systemPrompt: opts.systemPrompt,
          tools: opts.genericTools,
          maxToolResultChars: env.CHAT_MAX_TOOL_RESULT_CHARS
            ? Number(env.CHAT_MAX_TOOL_RESULT_CHARS)
            : undefined,
          maxContextTokens: env.CHAT_MAX_CONTEXT_TOKENS
            ? Number(env.CHAT_MAX_CONTEXT_TOKENS)
            : undefined,
          fetchTimeout: env.CHAT_FETCH_TIMEOUT
            ? Number(env.CHAT_FETCH_TIMEOUT)
            : undefined,
        }),
    });
  }

  return registry;
}

/**
 * Collect env vars required by eligible skills from process.env.
 * Used to forward skill-specific API keys to ClaudeProvider's subprocess.
 */
export function collectSkillEnv(skillsDirs: string[]): Record<string, string> {
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
