import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "../../src/chat/system-prompt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");

describe("buildSystemPrompt", () => {
  it("should include bootstrap files (SOUL.md, TOOLS.md) from workspace", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: projectRoot,
      skillsDirs: [resolve(projectRoot, "src/skills/builtins")],
    });

    expect(prompt).toContain("AI Claw Assistant");
    // SOUL.md personality section
    expect(prompt).toContain("Personality");
    // TOOLS.md tool usage section
    expect(prompt).toContain("Tool Usage");
  });

  it("should include skill summaries in XML format with file_read guidance", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: projectRoot,
      skillsDirs: [resolve(projectRoot, "src/skills/builtins")],
    });

    expect(prompt).toContain("Skills (mandatory)");
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>weather</name>");
    expect(prompt).toContain("<location>");
    expect(prompt).toContain("file_read");
    expect(prompt).not.toContain("get_skill");
  });

  it("should include custom tools when provided", () => {
    const prompt = buildSystemPrompt({
      workspaceDir: projectRoot,
      skillsDirs: [resolve(projectRoot, "src/skills/builtins")],
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
