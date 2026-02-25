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
      skillsDirs: [resolve(projectRoot, "src/skills")],
    });

    expect(prompt).toContain("AI Claw Assistant");
    expect(prompt).toContain("Chat Assistant");
  });

  it("should include skill summaries and get_skill guidance", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: projectRoot,
      skillsDirs: [resolve(projectRoot, "src/skills")],
    });

    expect(prompt).toContain("Skills (mandatory)");
    // Check for a skill with no requirements (always eligible)
    expect(prompt).toContain("weather");
    expect(prompt).toContain("get_skill");
  });

  it("should include custom tools when provided", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: projectRoot,
      skillsDirs: [resolve(projectRoot, "src/skills")],
      tools: ["`sentry_query(issue_id)` — Query Sentry"],
    });

    expect(prompt).toContain("Available Tools");
    expect(prompt).toContain("sentry_query");
  });

  it("should include runtime info in identity section", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: "/tmp/test",
      skillsDirs: ["/nonexistent"],
    });

    expect(prompt).toContain("Workspace: /tmp/test");
    expect(prompt).toContain(process.platform);
  });
});
