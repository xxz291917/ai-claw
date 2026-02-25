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

  it("should parse requires-env as array", () => {
    const content = `---
name: notion
requires-env: [NOTION_API_KEY]
---
Body`;

    const { metadata } = parseSkillFrontmatter(content);
    expect(metadata!["requires-env"]).toEqual(["NOTION_API_KEY"]);
  });

  it("should parse requires-env as string", () => {
    const content = `---
name: github
requires-env: GH_TOKEN
---
Body`;

    const { metadata } = parseSkillFrontmatter(content);
    expect(metadata!["requires-env"]).toBe("GH_TOKEN");
  });

  it("should parse requires-bins as array", () => {
    const content = `---
name: github
requires-bins: [gh, git]
---
Body`;

    const { metadata } = parseSkillFrontmatter(content);
    expect(metadata!["requires-bins"]).toEqual(["gh", "git"]);
  });

  it("should parse multiple requires fields together", () => {
    const content = `---
name: github
requires-env: [GH_TOKEN]
requires-bins: [gh]
---
Body`;

    const { metadata } = parseSkillFrontmatter(content);
    expect(metadata!["requires-env"]).toEqual(["GH_TOKEN"]);
    expect(metadata!["requires-bins"]).toEqual(["gh"]);
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
