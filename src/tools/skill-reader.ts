import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { z } from "zod";
import { parseSkillFrontmatter } from "../skills/frontmatter.js";
import type { UnifiedToolDef } from "./types.js";

/**
 * Creates a get_skill tool that lets the LLM load full skill content on demand.
 *
 * System prompt injects skill summaries; this tool provides the full text
 * when the LLM decides a skill matches the current task.
 */
export function createSkillReaderTool(skillsDir: string): UnifiedToolDef {
  // Pre-scan available skill names (with descriptions from frontmatter)
  const available = listSkillSummaries(skillsDir);

  return {
    name: "get_skill",
    description:
      "Load the full instructions for a skill by name. " +
      "Use this when the user's task matches one of the available skills listed in your system prompt. " +
      `Available skills: ${available.map((s) => s.name).join(", ") || "none"}`,
    inputSchema: {
      skill_name: z
        .string()
        .describe("Skill name (without .md extension), e.g. 'fault-healing'"),
    },
    parameters: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Skill name (without .md extension)" },
      },
      required: ["skill_name"],
    },
    execute: async (args: { skill_name: string }) => {
      const filePath = resolve(skillsDir, `${args.skill_name}.md`);
      try {
        return readFileSync(filePath, "utf-8");
      } catch {
        const names = listSkillSummaries(skillsDir).map((s) => s.name);
        return `Error: Skill "${args.skill_name}" not found. Available: ${names.join(", ") || "none"}`;
      }
    },
  };
}

type SkillSummary = { name: string; description: string };

function listSkillSummaries(skillsDir: string): SkillSummary[] {
  let files: string[];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  return files.map((file) => {
    const name = basename(file, ".md");
    try {
      const content = readFileSync(resolve(skillsDir, file), "utf-8");
      const { metadata, body } = parseSkillFrontmatter(content);
      const description =
        metadata?.description ??
        body
          .split("\n")
          .find((l) => l.trim().length > 0)
          ?.replace(/^#+\s*/, "")
          .trim() ??
        name;
      return { name, description };
    } catch {
      return { name, description: name };
    }
  });
}
