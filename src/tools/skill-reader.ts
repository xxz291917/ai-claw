import { readFileSync } from "node:fs";
import { z } from "zod";
import { scanSkillDirs, type SkillEntry } from "../skills/loader.js";
import type { UnifiedToolDef } from "./types.js";

/**
 * Creates a get_skill tool that lets the LLM load full skill content on demand.
 *
 * System prompt injects skill summaries; this tool provides the full text
 * when the LLM decides a skill matches the current task.
 */
export function createSkillReaderTool(skillsDirs: string[]): UnifiedToolDef {
  // Pre-scan available skills from all directories
  const available = scanSkillDirs(skillsDirs);
  const byName = new Map<string, SkillEntry>(available.map((s) => [s.name, s]));

  return {
    name: "get_skill",
    description:
      "Load the full instructions for a skill by name. " +
      "Use this when the user's task matches one of the available skills listed in your system prompt. " +
      `Available skills: ${available.map((s) => s.name).join(", ") || "none"}`,
    inputSchema: {
      skill_name: z
        .string()
        .describe("Skill name, e.g. 'github'"),
    },
    parameters: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Skill name" },
      },
      required: ["skill_name"],
    },
    execute: async (args: { skill_name: string }) => {
      const entry = byName.get(args.skill_name);
      if (entry) {
        try {
          return readFileSync(entry.filePath, "utf-8");
        } catch {
          // fall through to error
        }
      }
      const names = available.map((s) => s.name);
      return `Error: Skill "${args.skill_name}" not found. Available: ${names.join(", ") || "none"}`;
    },
  };
}
