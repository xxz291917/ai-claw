import { describe, it, expect, vi, afterEach } from "vitest";
import { createWebFetchTool } from "../../../src/agent/tools/web-fetch.js";

describe("createWebFetchTool", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should strip HTML and return text", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => `
        <html>
          <head><title>Test</title></head>
          <body>
            <script>alert('hi')</script>
            <style>body{color:red}</style>
            <nav>Nav stuff</nav>
            <h1>Main Heading</h1>
            <p>Useful content here.</p>
            <footer>Footer stuff</footer>
          </body>
        </html>
      `,
    }) as any;

    const tool = createWebFetchTool();
    const result = await tool.handler({ url: "https://example.com" });
    const text = result.content[0].text;

    expect(text).not.toContain("<script>");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<style>");
    expect(text).not.toContain("Nav stuff");
    expect(text).not.toContain("Footer stuff");
    expect(text).toContain("Main Heading");
    expect(text).toContain("Useful content");
  });

  it("should use Firecrawl when API key provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { markdown: "# Extracted Markdown\n\nClean content." },
      }),
    }) as any;

    const tool = createWebFetchTool({ firecrawlApiKey: "fc-test" });
    const result = await tool.handler({ url: "https://firecrawl-test.example.com" });

    expect(result.content[0].text).toBe(
      "# Extracted Markdown\n\nClean content.",
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("firecrawl"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fc-test",
        }),
      }),
    );
  });

  it("should fallback to direct fetch when Firecrawl fails", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) {
        // Firecrawl fails
        return { ok: false, status: 500, statusText: "Error" };
      }
      // Direct fetch succeeds
      return {
        ok: true,
        headers: new Headers({ "content-type": "text/html" }),
        text: async () => "<html><body><p>Fallback content</p></body></html>",
      };
    }) as any;

    const tool = createWebFetchTool({ firecrawlApiKey: "fc-test" });
    const result = await tool.handler({ url: "https://fallback-test.example.com" });

    expect(result.content[0].text).toContain("Fallback content");
  });

  it("should handle fetch errors gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
    }) as any;

    const tool = createWebFetchTool();
    const text = await tool.plainHandler({ url: "https://gone.example.com" });

    expect(text).toContain("404");
  });

  it("should truncate content exceeding maxChars", async () => {
    const longContent = "x".repeat(100);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => longContent,
    }) as any;

    const tool = createWebFetchTool();
    const result = await tool.handler({ url: "https://example.com", maxChars: 50 });

    expect(result.content[0].text.length).toBeLessThan(100);
    expect(result.content[0].text).toContain("Truncated");
  });

  it("should pretty-print JSON responses", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ key: "value", nested: { a: 1 } }),
    }) as any;

    const tool = createWebFetchTool();
    const result = await tool.handler({ url: "https://api.example.com/data" });

    expect(result.content[0].text).toContain('"key": "value"');
    expect(result.content[0].text).toContain('"nested"');
  });
});
