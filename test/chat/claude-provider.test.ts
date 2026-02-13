import { describe, it, expect } from "vitest";

describe("ClaudeProvider", () => {
  it("should have name 'claude'", async () => {
    const { ClaudeProvider } = await import("../../src/chat/claude-provider.js");
    const provider = new ClaudeProvider({
      workspaceDir: "/tmp/test",
      skillContent: "You are a helpful assistant.",
    });
    expect(provider.name).toBe("claude");
  });
});
