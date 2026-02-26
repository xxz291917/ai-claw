import type { ChatProvider } from "./types.js";

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

  list(): ProviderSpec[] {
    return [...this.specs.values()];
  }
}
