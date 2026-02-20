import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolSuite } from "../../src/tools/suite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(__dirname, "../../src/skills");

describe("buildToolSuite", () => {
  it("includes base tools (get_skill, web_fetch, claude_code)", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDir);

    expect(result.mcpServers["ai-hub-tools"]).toBeDefined();
    expect(result.descriptions.length).toBeGreaterThanOrEqual(3);
    expect(result.descriptions.some((d) => d.includes("get_skill"))).toBe(true);
    expect(result.descriptions.some((d) => d.includes("web_fetch"))).toBe(true);
    expect(result.descriptions.some((d) => d.includes("claude_code"))).toBe(true);
  });

  it("includes sentry_query when config is complete", () => {
    const result = buildToolSuite(
      {
        WORKSPACE_DIR: "/tmp/test",
        SENTRY_AUTH_TOKEN: "tok",
        SENTRY_ORG: "org",
        SENTRY_PROJECT: "proj",
      },
      skillsDir,
    );

    expect(result.descriptions.some((d) => d.includes("sentry_query"))).toBe(true);
  });

  it("omits sentry_query when config is incomplete", () => {
    const result = buildToolSuite(
      {
        WORKSPACE_DIR: "/tmp/test",
        SENTRY_AUTH_TOKEN: "tok",
        // missing org and project
      },
      skillsDir,
    );

    expect(result.descriptions.some((d) => d.includes("sentry_query"))).toBe(false);
  });

  it("includes web_search when BRAVE_API_KEY is set", () => {
    const result = buildToolSuite(
      { WORKSPACE_DIR: "/tmp/test", BRAVE_API_KEY: "key" },
      skillsDir,
    );

    expect(result.descriptions.some((d) => d.includes("web_search"))).toBe(true);
  });

  it("omits web_search when BRAVE_API_KEY is missing", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDir);

    expect(result.descriptions.some((d) => d.includes("web_search"))).toBe(false);
  });

  it("includes bash_exec when enabled", () => {
    const result = buildToolSuite(
      { WORKSPACE_DIR: "/tmp/test", BASH_EXEC_ENABLED: "true" },
      skillsDir,
    );

    expect(result.descriptions.some((d) => d.includes("bash_exec"))).toBe(true);
  });

  it("omits bash_exec when not enabled", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDir);

    expect(result.descriptions.some((d) => d.includes("bash_exec"))).toBe(false);
  });

  it("returns genericTools matching descriptions count", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDir);

    expect(result.genericTools.length).toBe(result.descriptions.length);
  });
});
