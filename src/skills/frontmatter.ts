/**
 * Skill frontmatter parser (Claude Code compatible format).
 *
 * Parses YAML frontmatter from skill markdown files without external dependencies.
 * Supports: name, description, tags, allowed-tools, user-invocable, disable-model-invocation,
 * requires-env, requires-bins.
 */

export type SkillMetadata = {
  name?: string;
  description?: string;
  tags?: string[];
  "allowed-tools"?: string;
  "user-invocable"?: boolean;
  "disable-model-invocation"?: boolean;
  /** Environment variables required by this skill (e.g. ["NOTION_API_KEY"]). */
  "requires-env"?: string[] | string;
  /** Binaries required on PATH (e.g. ["gh", "curl"]). */
  "requires-bins"?: string[] | string;
};

export type ParsedSkill = {
  metadata: SkillMetadata | null;
  body: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)---\r?\n([\s\S]*)$/;

/**
 * Parse a skill file into metadata (from YAML frontmatter) and body (markdown).
 * Returns `{ metadata: null, body: content }` if no valid frontmatter found.
 */
export function parseSkillFrontmatter(content: string): ParsedSkill {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { metadata: null, body: content };
  }

  try {
    const metadata = parseSimpleYaml(match[1]);
    return { metadata, body: match[2] };
  } catch {
    return { metadata: null, body: content };
  }
}

/**
 * Minimal YAML parser for flat key-value frontmatter.
 * Handles: strings, booleans, and bracket-style arrays.
 * Does NOT handle nested objects or multi-line values.
 */
function parseSimpleYaml(yaml: string): SkillMetadata {
  const result: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    // Only parse top-level keys (no leading whitespace) to avoid
    // nested YAML (e.g. workflow args/steps) overwriting top-level values.
    if (line.length > 0 && (line[0] === " " || line[0] === "\t")) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value: string = trimmed.slice(colonIdx + 1).trim();

    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Bracket-style array: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      result[key] = inner
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) =>
          (s.startsWith('"') && s.endsWith('"')) ||
          (s.startsWith("'") && s.endsWith("'"))
            ? s.slice(1, -1)
            : s,
        );
      continue;
    }

    // Boolean
    if (value === "true") {
      result[key] = true;
      continue;
    }
    if (value === "false") {
      result[key] = false;
      continue;
    }

    result[key] = value;
  }

  return result as SkillMetadata;
}
