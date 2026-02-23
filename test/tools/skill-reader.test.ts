import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillReaderTool } from "../../src/tools/skill-reader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(__dirname, "../../src/skills");

describe("createSkillReaderTool", () => {
  const tool = createSkillReaderTool(skillsDir);

  it("should return full skill content for a valid skill name", async () => {
    const text = await tool.execute({ skill_name: "github" });
    expect(text).toContain("GitHub");
    expect(text).not.toContain("Error:");
  });

  it("should return error for unknown skill name", async () => {
    const text = await tool.execute({ skill_name: "nonexistent" });
    expect(text).toContain("Error:");
    expect(text).toContain("not found");
    expect(text).toContain("github");
  });

  it("should list available skills in description", () => {
    expect(tool.description).toContain("github");
  });
});
