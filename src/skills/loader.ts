/**
 * Shared skill scanner — discovers skills from multiple directories,
 * supporting both flat files (<dir>/<name>.md) and OpenClaw/ClawHub
 * directory format (<dir>/<name>/SKILL.md).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parseSkillFrontmatter } from "./frontmatter.js";
import {
  extractRequirements,
  checkEligibility,
  type SkillRequirements,
  type EligibilityResult,
} from "./eligibility.js";

export type SkillEntry = {
  /** Skill identifier (from frontmatter name or filename/dirname). */
  name: string;
  /** Short description for system prompt listing. */
  description: string;
  /** Optional tags for prompt display. */
  tags?: string[];
  /** Absolute path to the .md file (for on-demand reading). */
  filePath: string;
  /** Declared env/bin dependencies. */
  requirements: SkillRequirements;
  /** Whether dependencies are satisfied in the current environment. */
  eligibility: EligibilityResult;
};

/** Return only eligible skills from the full list. */
export function filterEligibleSkills(skills: SkillEntry[]): SkillEntry[] {
  return skills.filter((s) => s.eligibility.eligible);
}

/**
 * Scan multiple directories for skills. Supports two formats:
 * - Flat: `<dir>/<name>.md`
 * - Directory (OpenClaw/ClawHub): `<dir>/<name>/SKILL.md`
 *
 * Directories are scanned in order; first occurrence of a name wins
 * (earlier dirs have higher precedence).
 */
export function scanSkillDirs(dirs: string[]): SkillEntry[] {
  const seen = new Set<string>();
  const entries: SkillEntry[] = [];

  for (const dir of dirs) {
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      continue; // directory doesn't exist — skip silently
    }

    for (const item of items) {
      const fullPath = resolve(dir, item);

      // Skip non-.md, utility files, and _-prefixed (disabled) entries
      if (item === "frontmatter.ts" || item === "loader.ts") continue;
      if (item.startsWith("_")) continue;

      let filePath: string | null = null;
      let inferredName: string;

      // Check if it's a directory with SKILL.md (OpenClaw format)
      try {
        if (statSync(fullPath).isDirectory()) {
          const skillMd = resolve(fullPath, "SKILL.md");
          try {
            statSync(skillMd);
            filePath = skillMd;
            inferredName = item; // directory name
          } catch {
            continue; // no SKILL.md — skip
          }
        } else if (item.endsWith(".md")) {
          filePath = fullPath;
          inferredName = basename(item, ".md");
        } else {
          continue;
        }
      } catch {
        continue;
      }

      if (!filePath) continue;

      // Parse metadata
      const entry = parseSkillFile(filePath, inferredName);
      if (!entry) continue;

      // Dedup by name (first wins)
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      entries.push(entry);
    }
  }

  return entries;
}

function parseSkillFile(
  filePath: string,
  fallbackName: string,
): SkillEntry | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { metadata, body } = parseSkillFrontmatter(content);

    const name = metadata?.name ?? fallbackName;

    const description =
      metadata?.description ??
      body
        .split("\n")
        .find((l) => l.trim().length > 0)
        ?.replace(/^#+\s*/, "")
        .trim() ??
      name;

    const requirements = extractRequirements(metadata);
    const eligibility = checkEligibility(requirements);

    return {
      name,
      description,
      tags: metadata?.tags,
      filePath,
      requirements,
      eligibility,
    };
  } catch {
    return null;
  }
}
