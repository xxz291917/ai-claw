import { describe, it, expect } from "vitest";
import { createSentryQueryTool } from "../../src/tools/sentry-query.js";

describe("sentry_query tool", () => {
  it("returns tool definition with correct name and schema", () => {
    const tool = createSentryQueryTool({
      authToken: "test-token",
      org: "test-org",
      project: "test-project",
    });

    expect(tool.name).toBe("sentry_query");
    expect(tool.description).toContain("Sentry");
    expect(tool.inputSchema.issue_id).toBeDefined();
    expect(tool.execute).toBeTypeOf("function");
  });

  it("accepts optional baseUrl for self-hosted instances", () => {
    const tool = createSentryQueryTool({
      baseUrl: "https://sentry.example.com",
      authToken: "test-token",
      org: "test-org",
      project: "test-project",
    });

    expect(tool.name).toBe("sentry_query");
    expect(tool.execute).toBeTypeOf("function");
  });
});
