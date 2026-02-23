import { readFileSync } from "node:fs";
import { dirname } from "node:path";
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
  // Snapshot for the static description field (MCP tool descriptions are immutable after construction).
  // The execute() function re-scans on every call so newly installed skills are found immediately.
  const initialScan = scanSkillDirs(skillsDirs);

  return {
    name: "get_skill",
    description:
      "Load the full instructions for a skill by name. " +
      "Use this when the user's task matches one of the available skills listed in your system prompt. " +
      `Available skills: ${initialScan.map((s) => s.name).join(", ") || "none"}`,
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
    execute: async (args: { skill_name: string }, _ctx) => {
      // Re-scan on every call — picks up newly installed skills without restart
      const current = scanSkillDirs(skillsDirs);
      const byName = new Map<string, SkillEntry>(current.map((s) => [s.name, s]));

      const entry = byName.get(args.skill_name);
      if (entry) {
        try {
          const content = readFileSync(entry.filePath, "utf-8");
          const skillDir = dirname(entry.filePath);
          return (
            `[Skill directory: ${skillDir}]\n` +
            `[IMPORTANT: When executing files from this skill, use absolute paths. ` +
            `For example: node ${skillDir}/index.js or bash_exec with cwd=${skillDir}]\n\n` +
            content
          );
        } catch {
          // fall through to error
        }
      }
      const names = current.map((s) => s.name);
      return `Error: Skill "${args.skill_name}" not found. Available: ${names.join(", ") || "none"}`;
    },
  };
}
