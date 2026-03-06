import { describe, it, expect } from "vitest";
import { bridgeMcpTools } from "../../src/mcp/bridge.js";

describe("bridgeMcpTools", () => {
  it("returns empty results for empty config", async () => {
    const result = await bridgeMcpTools({});
    expect(result.tools).toEqual([]);
    expect(result.claudeServerConfigs).toEqual({});
    expect(result.connected).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
