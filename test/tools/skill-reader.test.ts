import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createSkillReaderTool } from "../../src/tools/skill-reader.js";

const ctx = { userId: "test", sessionId: "test" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const builtinDir = resolve(__dirname, "../../src/skills");

// ClawHub-format test directory
const tmpExtra = resolve("/tmp", `skill-reader-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(resolve(tmpExtra, "test-claw-skill"), { recursive: true });
  writeFileSync(
    resolve(tmpExtra, "test-claw-skill", "SKILL.md"),
    `---
name: test-claw-skill
description: A test ClawHub skill
---
# Test ClawHub Skill
Hello from ClawHub.`,
  );
});

afterAll(() => {
  rmSync(tmpExtra, { recursive: true, force: true });
});

describe("createSkillReaderTool", () => {
  it("should return full skill content for a builtin skill", async () => {
    const tool = createSkillReaderTool([builtinDir]);
    const text = await tool.execute({ skill_name: "github" }, ctx);
    expect(text).toContain("GitHub");
    expect(text).not.toContain("Error:");
  });

  it("should return error for unknown skill name", async () => {
    const tool = createSkillReaderTool([builtinDir]);
    const text = await tool.execute({ skill_name: "nonexistent" }, ctx);
    expect(text).toContain("Error:");
    expect(text).toContain("not found");
    expect(text).toContain("github");
  });

  it("should list available skills in description", () => {
    const tool = createSkillReaderTool([builtinDir]);
    expect(tool.description).toContain("github");
  });

  it("should discover ClawHub directory-format skills", async () => {
    const tool = createSkillReaderTool([builtinDir, tmpExtra]);
    expect(tool.description).toContain("test-claw-skill");

    const text = await tool.execute({ skill_name: "test-claw-skill" }, ctx);
    expect(text).toContain("Hello from ClawHub");
    expect(text).not.toContain("Error:");
  });

  it("should merge skills from multiple directories", () => {
    const tool = createSkillReaderTool([builtinDir, tmpExtra]);
    expect(tool.description).toContain("github");
    expect(tool.description).toContain("test-claw-skill");
  });
});
