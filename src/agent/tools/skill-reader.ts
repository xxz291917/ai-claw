import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { z } from "zod";

/**
 * Creates a get_skill tool that lets the LLM load full skill content on demand.
 *
 * System prompt injects skill summaries; this tool provides the full text
 * when the LLM decides a skill matches the current task.
 */
export function createSkillReaderTool(skillsDir: string) {
  // Pre-scan available skill names for validation
  const available = listSkillNames(skillsDir);

  return {
    name: "get_skill",
    description:
      "Load the full instructions for a skill by name. " +
      "Use this when the user's task matches one of the available skills listed in your system prompt. " +
      `Available skills: ${available.join(", ") || "none"}`,
    inputSchema: {
      skill_name: z
        .string()
        .describe("Skill name (without .md extension), e.g. 'fault-healing'"),
    },
    handler: async (args: { skill_name: string }) => {
      const filePath = resolve(skillsDir, `${args.skill_name}.md`);
      try {
        const content = readFileSync(filePath, "utf-8");
        return {
          content: [{ type: "text" as const, text: content }],
        };
      } catch {
        const names = listSkillNames(skillsDir);
        return {
          content: [
            {
              type: "text" as const,
              text: `Skill "${args.skill_name}" not found. Available: ${names.join(", ") || "none"}`,
            },
          ],
          isError: true,
        };
      }
    },
    /** Simplified handler for GenericProvider (returns plain string) */
    plainHandler: async (args: { skill_name: string }): Promise<string> => {
      const filePath = resolve(skillsDir, `${args.skill_name}.md`);
      try {
        return readFileSync(filePath, "utf-8");
      } catch {
        const names = listSkillNames(skillsDir);
        return `Skill "${args.skill_name}" not found. Available: ${names.join(", ") || "none"}`;
      }
    },
  };
}

function listSkillNames(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"));
  } catch {
    return [];
  }
}
