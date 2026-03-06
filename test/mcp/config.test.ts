import { describe, it, expect } from "vitest";
import { parseMcpConfig, type McpServerConfig } from "../../src/mcp/config.js";

describe("parseMcpConfig", () => {
  it("parses valid config with url only", () => {
    const raw = { github: { url: "http://localhost:3001/sse" } };
    const result = parseMcpConfig(raw);
    expect(result).toEqual({
      github: { url: "http://localhost:3001/sse", headers: {} },
    });
  });

  it("parses config with headers", () => {
    const raw = {
      notion: {
        url: "http://remote:8080/sse",
        headers: { Authorization: "Bearer tok" },
      },
    };
    const result = parseMcpConfig(raw);
    expect(result.notion.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("parses empty config", () => {
    const result = parseMcpConfig({});
    expect(result).toEqual({});
  });

  it("throws on missing url", () => {
    expect(() => parseMcpConfig({ bad: {} } as any)).toThrow();
  });

  it("throws on invalid url type", () => {
    expect(() => parseMcpConfig({ bad: { url: 123 } } as any)).toThrow();
  });
});
