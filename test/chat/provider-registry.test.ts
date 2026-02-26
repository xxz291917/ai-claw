import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../../src/chat/provider-registry.js";
import { scanProviderEnvVars } from "../../src/chat/provider-registry.js";
import type { ChatProvider } from "../../src/chat/types.js";

function fakeProvider(name: string): ChatProvider {
  return {
    name,
    async *stream() {
      yield { type: "text" as const, content: "hi" };
      yield { type: "done" as const, sessionId: "", costUsd: 0 };
    },
  };
}

describe("ProviderRegistry", () => {
  it("registers and creates a provider", () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => fakeProvider("test"),
    });

    const provider = registry.create("test");
    expect(provider.name).toBe("test");
  });

  it("throws on unknown provider name", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.create("nope")).toThrow(/not registered/i);
  });

  it("lists all registered specs", () => {
    const registry = new ProviderRegistry();
    registry.register({ name: "a", type: "claude", factory: () => fakeProvider("a") });
    registry.register({ name: "b", type: "openai-compatible", factory: () => fakeProvider("b") });
    expect(registry.list().map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("has() returns true for registered, false for unknown", () => {
    const registry = new ProviderRegistry();
    registry.register({ name: "x", type: "claude", factory: () => fakeProvider("x") });
    expect(registry.has("x")).toBe(true);
    expect(registry.has("y")).toBe(false);
  });
});

describe("scanProviderEnvVars", () => {
  it("extracts provider configs from PROVIDER_{NAME}_* env vars", () => {
    const env: Record<string, string | undefined> = {
      PROVIDER_DEEPSEEK_API_BASE: "https://api.deepseek.com",
      PROVIDER_DEEPSEEK_API_KEY: "sk-deep",
      PROVIDER_DEEPSEEK_MODEL: "deepseek-chat",
      PROVIDER_QWEN_API_BASE: "https://qwen.api",
      PROVIDER_QWEN_API_KEY: "sk-qwen",
      OTHER_VAR: "ignored",
    };

    const configs = scanProviderEnvVars(env);
    expect(configs).toHaveLength(2);

    const ds = configs.find((c) => c.name === "deepseek");
    expect(ds).toMatchObject({
      name: "deepseek",
      apiBase: "https://api.deepseek.com",
      apiKey: "sk-deep",
      model: "deepseek-chat",
    });

    const qw = configs.find((c) => c.name === "qwen");
    expect(qw).toMatchObject({
      name: "qwen",
      apiBase: "https://qwen.api",
      apiKey: "sk-qwen",
    });
    expect(qw!.model).toBeUndefined();
  });

  it("skips providers missing API_BASE or API_KEY", () => {
    const env = {
      PROVIDER_INCOMPLETE_API_BASE: "https://example.com",
    };
    const configs = scanProviderEnvVars(env);
    expect(configs).toHaveLength(0);
  });
});
