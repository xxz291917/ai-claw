import type { ChatProvider } from "./types.js";

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
