import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { scanSkillDirs } from "../../src/skills/loader.js";

const tmp = resolve("/tmp", `skill-loader-test-${Date.now()}`);
const flatDir = resolve(tmp, "flat");
const clawDir = resolve(tmp, "claw");
const emptyDir = resolve(tmp, "empty");

beforeAll(() => {
  // Flat format skills
  mkdirSync(flatDir, { recursive: true });
  writeFileSync(
    resolve(flatDir, "github.md"),
    `---
name: github
description: GitHub operations
tags: [git, ci]
---
# GitHub
Use gh CLI.`,
  );
  writeFileSync(
    resolve(flatDir, "weather.md"),
    `---
name: weather
description: Get weather info
---
# Weather`,
  );

  // ClawHub directory format skills
  mkdirSync(resolve(clawDir, "demo-skill"), { recursive: true });
  writeFileSync(
    resolve(clawDir, "demo-skill", "SKILL.md"),
    `---
name: demo-skill
description: A demo skill from ClawHub
tags: [demo]
---
# Demo Skill
This is a demo.`,
  );

  // Duplicate name (should be overridden by flat dir)
  mkdirSync(resolve(clawDir, "github"), { recursive: true });
  writeFileSync(
    resolve(clawDir, "github", "SKILL.md"),
    `---
name: github
description: ClawHub version of GitHub
---
# GitHub (ClawHub)`,
  );

  // Directory without SKILL.md (should be skipped)
  mkdirSync(resolve(clawDir, "no-skill"), { recursive: true });
  writeFileSync(resolve(clawDir, "no-skill", "README.md"), "# Not a skill");

  // Empty dir
  mkdirSync(emptyDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("scanSkillDirs", () => {
  it("discovers flat .md skills", () => {
    const entries = scanSkillDirs([flatDir]);
    const names = entries.map((e) => e.name);
    expect(names).toContain("github");
    expect(names).toContain("weather");
  });

  it("discovers ClawHub directory-format skills", () => {
    const entries = scanSkillDirs([clawDir]);
    const names = entries.map((e) => e.name);
    expect(names).toContain("demo-skill");
    expect(names).toContain("github");
  });

  it("extracts metadata correctly", () => {
    const entries = scanSkillDirs([flatDir]);
    const gh = entries.find((e) => e.name === "github")!;
    expect(gh.description).toBe("GitHub operations");
    expect(gh.tags).toEqual(["git", "ci"]);
    expect(gh.filePath).toBe(resolve(flatDir, "github.md"));
  });

  it("extracts metadata from ClawHub SKILL.md", () => {
    const entries = scanSkillDirs([clawDir]);
    const demo = entries.find((e) => e.name === "demo-skill")!;
    expect(demo.description).toBe("A demo skill from ClawHub");
    expect(demo.tags).toEqual(["demo"]);
    expect(demo.filePath).toBe(resolve(clawDir, "demo-skill", "SKILL.md"));
  });

  it("deduplicates by name — first dir wins", () => {
    const entries = scanSkillDirs([flatDir, clawDir]);
    const ghs = entries.filter((e) => e.name === "github");
    expect(ghs).toHaveLength(1);
    expect(ghs[0].description).toBe("GitHub operations"); // from flatDir
  });

  it("merges skills from multiple directories", () => {
    const entries = scanSkillDirs([flatDir, clawDir]);
    const names = entries.map((e) => e.name);
    expect(names).toContain("github");
    expect(names).toContain("weather");
    expect(names).toContain("demo-skill");
  });

  it("skips directories without SKILL.md", () => {
    const entries = scanSkillDirs([clawDir]);
    const names = entries.map((e) => e.name);
    expect(names).not.toContain("no-skill");
  });

  it("handles empty directories", () => {
    const entries = scanSkillDirs([emptyDir]);
    expect(entries).toEqual([]);
  });

  it("handles nonexistent directories", () => {
    const entries = scanSkillDirs(["/tmp/nonexistent-dir-xyz"]);
    expect(entries).toEqual([]);
  });

  it("marks skills without requires as eligible", () => {
    const entries = scanSkillDirs([flatDir]);
    const weather = entries.find((e) => e.name === "weather")!;
    expect(weather.requirements).toEqual({ env: [], bins: [] });
    expect(weather.eligibility.eligible).toBe(true);
  });

  it("marks skills with missing env as ineligible", () => {
    const reqDir = resolve(tmp, "requires-test");
    mkdirSync(reqDir, { recursive: true });
    writeFileSync(
      resolve(reqDir, "needs-key.md"),
      `---\nname: needs-key\nrequires-env: [NONEXISTENT_KEY_XYZ_TEST]\n---\n# Needs Key`,
    );
    const entries = scanSkillDirs([reqDir]);
    const skill = entries.find((e) => e.name === "needs-key")!;
    expect(skill.eligibility.eligible).toBe(false);
    expect(skill.eligibility.missingEnv).toContain("NONEXISTENT_KEY_XYZ_TEST");
  });

  it("populates requirements and eligibility on all entries", () => {
    const entries = scanSkillDirs([flatDir]);
    for (const entry of entries) {
      expect(entry).toHaveProperty("requirements");
      expect(entry).toHaveProperty("eligibility");
      expect(entry.requirements).toHaveProperty("env");
      expect(entry.requirements).toHaveProperty("bins");
    }
  });

  it("falls back to dirname/filename when no frontmatter name", () => {
    const noMeta = resolve(tmp, "nometa");
    mkdirSync(noMeta, { recursive: true });
    writeFileSync(resolve(noMeta, "simple.md"), "# Just a heading\nSome content.");

    const entries = scanSkillDirs([noMeta]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("simple");
    expect(entries[0].description).toBe("Just a heading");
  });
});
