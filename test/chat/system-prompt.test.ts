import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "../../src/chat/system-prompt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");

describe("buildSystemPrompt", () => {
  it("should include project knowledge from CLAUDE.md", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: projectRoot,
      skillsDir: resolve(projectRoot, "src/skills"),
    });

    expect(prompt).toContain("AI Hub Assistant");
    expect(prompt).toContain("Fault Healing Pipeline");
    expect(prompt).toContain("fault-healing");
  });

  it("should include skill summaries and get_skill guidance", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: projectRoot,
      skillsDir: resolve(projectRoot, "src/skills"),
    });

    expect(prompt).toContain("Skills (mandatory)");
    expect(prompt).toContain("fault-healing");
    expect(prompt).toContain("get_skill");
  });

  it("should include custom tools when provided", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: projectRoot,
      skillsDir: resolve(projectRoot, "src/skills"),
      tools: ["`sentry_query(issue_id)` — Query Sentry"],
    });

    expect(prompt).toContain("Available Tools");
    expect(prompt).toContain("sentry_query");
  });

  it("should include runtime info", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/tmp/test",
      skillsDir: "/nonexistent",
    });

    expect(prompt).toContain("Runtime");
    expect(prompt).toContain("/tmp/test");
    expect(prompt).toContain(process.platform);
  });
});
