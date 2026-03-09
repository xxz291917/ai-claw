import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolSuite } from "../../src/tools/suite.js";
import { MemoryManager } from "../../src/memory/manager.js";
import { createTestDb } from "../helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDirs = [resolve(__dirname, "../../src/skills")];

describe("buildToolSuite", () => {
  it("includes base tools (web_fetch, claude_code, file_read)", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDirs);

    expect(result.mcpServers["ai-claw-tools"]).toBeDefined();
    expect(result.descriptions.length).toBeGreaterThanOrEqual(3);
    expect(result.descriptions.some((d) => d.includes("web_fetch"))).toBe(true);
    expect(result.descriptions.some((d) => d.includes("claude_code"))).toBe(true);
    expect(result.descriptions.some((d) => d.includes("file_read"))).toBe(true);
    expect(result.descriptions.some((d) => d.includes("get_skill"))).toBe(false);
  });

  it("includes sentry_query when config is complete", () => {
    const result = buildToolSuite(
      {
        WORKSPACE_DIR: "/tmp/test",
        SENTRY_AUTH_TOKEN: "tok",
        SENTRY_ORG: "org",
        SENTRY_PROJECT: "proj",
      },
      skillsDirs,
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
      skillsDirs,
    );

    expect(result.descriptions.some((d) => d.includes("sentry_query"))).toBe(false);
  });

  it("includes web_search when BRAVE_API_KEY is set", () => {
    const result = buildToolSuite(
      { WORKSPACE_DIR: "/tmp/test", BRAVE_API_KEY: "key" },
      skillsDirs,
    );

    expect(result.descriptions.some((d) => d.includes("web_search"))).toBe(true);
  });

  it("omits web_search when BRAVE_API_KEY is missing", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDirs);

    expect(result.descriptions.some((d) => d.includes("web_search"))).toBe(false);
  });

  it("includes bash_exec when enabled", () => {
    const result = buildToolSuite(
      { WORKSPACE_DIR: "/tmp/test", BASH_EXEC_ENABLED: "true" },
      skillsDirs,
    );

    expect(result.descriptions.some((d) => d.includes("bash_exec"))).toBe(true);
  });

  it("omits bash_exec when not enabled", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDirs);

    expect(result.descriptions.some((d) => d.includes("bash_exec"))).toBe(false);
  });

  it("returns genericTools matching descriptions count", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDirs);

    expect(result.genericTools.length).toBe(result.descriptions.length);
  });

  it("includes memory tools when memoryManager is provided", () => {
    const db = createTestDb();
    const memoryManager = new MemoryManager(db);
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDirs, memoryManager);

    expect(result.descriptions.some((d) => d.includes("memory_save"))).toBe(true);
    expect(result.descriptions.some((d) => d.includes("memory_delete"))).toBe(true);
    expect(result.descriptions.some((d) => d.includes("memory_list"))).toBe(true);
  });

  it("omits memory tools when memoryManager is not provided", () => {
    const result = buildToolSuite({ WORKSPACE_DIR: "/tmp/test" }, skillsDirs);

    expect(result.descriptions.some((d) => d.includes("memory_save"))).toBe(false);
    expect(result.descriptions.some((d) => d.includes("memory_delete"))).toBe(false);
    expect(result.descriptions.some((d) => d.includes("memory_list"))).toBe(false);
  });
});
