import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillReaderTool } from "../../../src/agent/tools/skill-reader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = resolve(__dirname, "../../../src/skills");

describe("createSkillReaderTool", () => {
  const tool = createSkillReaderTool(skillsDir);

  it("should return full skill content for a valid skill name", async () => {
    const result = await tool.handler({ skill_name: "fault-healing" });
    expect(result.content[0].text).toContain("Fault Healing");
    expect(result.content[0].text).toContain("Phase: Analysis");
    expect(result.content[0].text).toContain("Phase: Fix");
    expect(result).not.toHaveProperty("isError");
  });

  it("should return error for unknown skill name", async () => {
    const result = await tool.handler({ skill_name: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("fault-healing");
  });

  it("plainHandler should return plain string", async () => {
    const text = await tool.plainHandler({ skill_name: "fault-healing" });
    expect(text).toContain("Fault Healing");
    expect(text).toContain("Phase: Analysis");
  });

  it("should list available skills in description", () => {
    expect(tool.description).toContain("fault-healing");
  });
});
