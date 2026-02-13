/**
 * Build system prompt for chat assistant.
 *
 * Follows OpenClaw's layered context injection pattern:
 *   1. Identity + role
 *   2. Project knowledge (CLAUDE.md)
 *   3. Available skills (from skills/ directory)
 *   4. Available tools
 *   5. Runtime info
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";

export type PromptContext = {
  workspaceDir: string;
  skillsDir: string;
  claudeMdPath?: string;
  tools?: string[];
};

export function buildSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [];

  // --- 1. Identity ---
  sections.push(`You are AI Hub Assistant, an AI engineering assistant for the AI Hub project.
You can read/write code, run commands, query Sentry, and help with any engineering task in this workspace.`);

  // --- 2. Project Knowledge (CLAUDE.md) ---
  const claudeMd = tryReadFile(ctx.claudeMdPath ?? resolve(ctx.workspaceDir, "CLAUDE.md"));
  if (claudeMd) {
    sections.push(`## Project Knowledge\n\n${claudeMd}`);
  }

  // --- 3. Available Skills ---
  const skills = loadSkills(ctx.skillsDir);
  if (skills.length > 0) {
    const skillList = skills
      .map((s) => `- **${s.name}**: ${s.summary}`)
      .join("\n");
    sections.push(`## Available Skills

The following skills define specialized workflows. When a task matches a skill, follow its instructions.

${skillList}

To use a skill, read its full content from the skills directory when the task matches.`);
  }

  // --- 4. Available Tools ---
  if (ctx.tools && ctx.tools.length > 0) {
    const toolList = ctx.tools.map((t) => `- ${t}`).join("\n");
    sections.push(`## Available Tools

In addition to built-in code tools (bash, read, write, edit, grep, glob), you have:

${toolList}`);
  }

  // --- 5. Runtime ---
  sections.push(`## Runtime

- Workspace: ${ctx.workspaceDir}
- Time: ${new Date().toISOString()}
- Platform: ${process.platform} ${process.arch}`);

  return sections.join("\n\n---\n\n");
}

type SkillEntry = { name: string; summary: string };

function loadSkills(skillsDir: string): SkillEntry[] {
  let files: string[];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  return files.map((file) => {
    const content = tryReadFile(resolve(skillsDir, file)) ?? "";
    // Extract first heading or first line as summary
    const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? file;
    const summary = firstLine.replace(/^#+\s*/, "").trim();
    return {
      name: basename(file, ".md"),
      summary,
    };
  });
}

function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
