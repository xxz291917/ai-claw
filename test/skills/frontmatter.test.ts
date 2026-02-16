import { describe, it, expect } from "vitest";
import { parseSkillFrontmatter } from "../../src/skills/frontmatter.js";

describe("parseSkillFrontmatter", () => {
  it("should parse valid Claude Code style frontmatter", () => {
    const content = `---
name: github
description: "Interact with GitHub using the gh CLI"
tags: [git, collaboration, ci-cd]
allowed-tools: Read, Grep, Glob
user-invocable: true
---

# GitHub Skill

Content here.`;

    const { metadata, body } = parseSkillFrontmatter(content);
    expect(metadata).not.toBeNull();
    expect(metadata!.name).toBe("github");
    expect(metadata!.description).toBe("Interact with GitHub using the gh CLI");
    expect(metadata!.tags).toEqual(["git", "collaboration", "ci-cd"]);
    expect(metadata!["allowed-tools"]).toBe("Read, Grep, Glob");
    expect(metadata!["user-invocable"]).toBe(true);
    expect(body).toContain("# GitHub Skill");
    expect(body).toContain("Content here.");
  });

  it("should handle skills without frontmatter (backward compat)", () => {
    const content = "# Old Style Skill\n\nNo frontmatter here.";
    const { metadata, body } = parseSkillFrontmatter(content);
    expect(metadata).toBeNull();
    expect(body).toBe(content);
  });

  it("should handle malformed frontmatter gracefully", () => {
    const content = `---
this is not valid yaml: [
---
# Content`;

    const { metadata, body } = parseSkillFrontmatter(content);
    // Should still extract something or fall back
    expect(body).toBeDefined();
  });

  it("should parse boolean values correctly", () => {
    const content = `---
name: test
disable-model-invocation: true
user-invocable: false
---
Body`;

    const { metadata } = parseSkillFrontmatter(content);
    expect(metadata!["disable-model-invocation"]).toBe(true);
    expect(metadata!["user-invocable"]).toBe(false);
  });

  it("should handle quoted strings", () => {
    const content = `---
name: test
description: "A skill with quotes"
---
Body`;

    const { metadata } = parseSkillFrontmatter(content);
    expect(metadata!.description).toBe("A skill with quotes");
  });

  it("should handle quoted items in arrays", () => {
    const content = `---
tags: ["tag one", "tag two", simple]
---
Body`;

    const { metadata } = parseSkillFrontmatter(content);
    expect(metadata!.tags).toEqual(["tag one", "tag two", "simple"]);
  });

  it("should handle empty frontmatter", () => {
    const content = `---
---
Body only`;

    const { metadata, body } = parseSkillFrontmatter(content);
    expect(metadata).not.toBeNull();
    expect(body).toContain("Body only");
  });
});
