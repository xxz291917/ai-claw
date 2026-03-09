/**
 * Build system prompt for chat assistant.
 *
 * Layered context injection (inspired by OpenClaw):
 *   1. Identity + runtime
 *   2. Safety guardrails
 *   3. Reasoning format
 *   4. Bootstrap files (SOUL.md, TOOLS.md — from prompts/ directory)
 *   5. Skills (mandatory selection flow)
 *   6. Available tools
 *
 * Bootstrap files replace the old hardcoded personality/tool-usage sections
 * and the monolithic CLAUDE.md injection. Each file is read from the prompts/
 * directory, truncated per-file, and injected according to the prompt mode.
 *
 * Memory Recall is handled via per-request injection in conversation.ts.
 * Per-tool guidelines are in each tool's description field.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanSkillDirs, type SkillEntry } from "../skills/loader.js";

export type PromptMode = "full" | "minimal";

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export type PromptContext = {
  workspaceDir: string;
  skillsDirs: string[];
  /** Directory containing bootstrap files (SOUL.md, TOOLS.md). Defaults to `<workspaceDir>/prompts` */
  promptsDir?: string;
  tools?: string[];
  /**
   * Prompt mode:
   * - "full" (default): all sections — for main agent interactions
   * - "minimal": compact prompt for sub-agents — identity, safety, reasoning, TOOLS.md only
   *   Omits: SOUL.md, skills, available tools list
   */
  mode?: PromptMode;
  /** Max chars per bootstrap file before truncation (default 20000) */
  bootstrapMaxChars?: number;
};

// ---------------------------------------------------------------------------
// Bootstrap file definitions
// ---------------------------------------------------------------------------

type BootstrapFile = {
  /** File name relative to prompts directory */
  filename: string;
  /** Section heading in the prompt */
  heading: string;
  /** Which modes include this file */
  modes: PromptMode[];
};

/**
 * Bootstrap files scanned from prompts directory.
 * Order matters — injected in this sequence.
 */
const BOOTSTRAP_FILES: BootstrapFile[] = [
  { filename: "SOUL.md",  heading: "Personality",  modes: ["full"] },
  { filename: "TOOLS.md", heading: "Tool Usage",   modes: ["full", "minimal"] },
];

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(ctx: PromptContext): string {
  const mode = ctx.mode ?? "full";
  const maxChars = ctx.bootstrapMaxChars ?? 20_000;
  const promptsDir = ctx.promptsDir ?? resolve(ctx.workspaceDir, "prompts");
  const sections: string[] = [];
  const absoluteWorkspace = resolve(ctx.workspaceDir);

  // --- 1. Identity + Runtime ---
  sections.push(`You are AI Claw Assistant, an AI engineering assistant.${
    mode === "full"
      ? "\nYou help with software engineering tasks: writing code, debugging, running commands, querying APIs, and project management."
      : ""
  }

Workspace: ${absoluteWorkspace} | Timezone: ${TIMEZONE} | Platform: ${process.platform} ${process.arch}`);

  // --- 2. Safety (always included) ---
  sections.push(`## Safety

- No independent goals. Do not pursue self-preservation, replication, or power-seeking.
- Prioritize safety and human oversight over task completion.
- Do not access files outside the workspace unless explicitly asked.
- Do not fabricate information. Report errors honestly.

Some tools with side effects (file_write, bash_exec with mutating commands, claude_code) are automatically gated by the system. If you receive a CONFIRMATION_REQUIRED response, relay it to the user and wait for approval before retrying.`);

  // --- 3. Reasoning Format (always included) ---
  sections.push(`## Reasoning

Put internal reasoning inside \`<think>...</think>\` tags. Only text outside is shown to the user.`);

  // --- 4. Bootstrap files ---
  for (const bf of BOOTSTRAP_FILES) {
    if (!bf.modes.includes(mode)) continue;
    const content = tryReadFile(resolve(promptsDir, bf.filename));
    if (!content) continue;
    const trimmed = truncateBootstrap(content, maxChars, bf.filename);
    sections.push(`## ${bf.heading}\n\n${trimmed}`);
  }

  // --- Sections below are full-mode only ---
  if (mode === "full") {
    // --- 5. Skills (mandatory selection flow, XML format) ---
    const skills = scanSkillDirs(ctx.skillsDirs).filter((s) => s.eligibility.eligible);
    if (skills.length > 0) {
      const MAX_SKILLS = 150;
      const MAX_SKILL_BLOCK_CHARS = 30_000;
      const displayed = skills.slice(0, MAX_SKILLS);
      const skillXml = displayed.map(skillToXml).join("\n");
      let skillBlock = `<available_skills>\n${skillXml}\n</available_skills>`;
      if (skillBlock.length > MAX_SKILL_BLOCK_CHARS) {
        skillBlock = skillBlock.slice(0, MAX_SKILL_BLOCK_CHARS) + "\n<!-- truncated -->";
      }
      if (skills.length > MAX_SKILLS) {
        skillBlock += `\n<!-- ${skills.length - MAX_SKILLS} additional skills omitted -->`;
      }
      sections.push(`## Skills (mandatory)

Before replying, check if any skill below matches the user's task:
- If a skill matches → read its file with \`file_read\` using the \`<location>\` path, then follow the instructions inside.
- If multiple match → pick the most specific one.
- If none match → answer directly without loading any skill.

Do NOT read more than one skill up front. Do NOT guess file paths — always use the \`<location>\` value.

${skillBlock}`);
    }

    // --- 6. Available Tools ---
    if (ctx.tools && ctx.tools.length > 0) {
      const toolList = ctx.tools.map((t) => `- ${t}`).join("\n");
      sections.push(`## Available Tools

${toolList}`);
    }
  }

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function skillToXml(s: SkillEntry): string {
  const lines = [
    `  <skill>`,
    `    <name>${escapeXml(s.name)}</name>`,
    `    <description>${escapeXml(s.description)}</description>`,
    `    <location>${s.filePath}</location>`,
  ];
  if (s.tags?.length) lines.push(`    <tags>${s.tags.join(", ")}</tags>`);
  lines.push(`  </skill>`);
  return lines.join("\n");
}

/**
 * Truncate a bootstrap file to maxChars using head+tail strategy
 * (keep 70% from start + 20% from end + truncation marker).
 */
function truncateBootstrap(content: string, maxChars: number, filename: string): string {
  if (content.length <= maxChars) return content;
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.floor(maxChars * 0.2);
  const marker = `\n\n[...${filename} truncated: ${content.length} chars → ${maxChars} max...]\n\n`;
  return content.slice(0, headSize) + marker + content.slice(-tailSize);
}
