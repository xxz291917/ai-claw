import { describe, it, expect } from "vitest";
import { createSentryQueryTool } from "../../../src/agent/tools/sentry-query.js";

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
    expect(tool.handler).toBeTypeOf("function");
  });
});
