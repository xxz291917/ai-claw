import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebSearchTool } from "../../../src/agent/tools/web-search.js";

describe("createWebSearchTool", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should format search results correctly", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            {
              title: "TypeScript Docs",
              url: "https://typescriptlang.org",
              description: "Official TypeScript documentation",
            },
            {
              title: "TS Playground",
              url: "https://typescriptlang.org/play",
              description: "Try TypeScript online",
            },
          ],
        },
      }),
    }) as any;

    const tool = createWebSearchTool({ apiKey: "test-key" });
    const result = await tool.handler({ query: "typescript", count: 2 });

    expect(result.content[0].text).toContain("TypeScript Docs");
    expect(result.content[0].text).toContain("https://typescriptlang.org");
    expect(result.content[0].text).toContain("TS Playground");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("q=typescript"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Subscription-Token": "test-key",
        }),
      }),
    );
  });

  it("should handle API errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    }) as any;

    const tool = createWebSearchTool({ apiKey: "test-key" });
    const result = await tool.handler({ query: "test" });

    expect(result.content[0].text).toContain("429");
  });

  it("should return 'No results' for empty response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    }) as any;

    const tool = createWebSearchTool({ apiKey: "test-key" });
    const text = await tool.plainHandler({ query: "xyznonexistent" });

    expect(text).toContain("No results");
  });

  it("plainHandler should return plain string", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        web: {
          results: [
            { title: "Result", url: "https://x.com", description: "desc" },
          ],
        },
      }),
    }) as any;

    const tool = createWebSearchTool({ apiKey: "key" });
    const text = await tool.plainHandler({ query: "test" });

    expect(typeof text).toBe("string");
    expect(text).toContain("Result");
  });
});
