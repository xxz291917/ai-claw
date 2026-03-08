import { readFileSync } from "node:fs";
import type { WorkflowDefinition, WorkflowArgDef, WorkflowStep } from "./types.js";

/**
 * Extract frontmatter string from markdown content.
 * Returns null if no valid frontmatter delimiters found.
 */
function extractFrontmatter(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return null;
  return content.slice(4, endIdx);
}

/**
 * Extract a scalar value for a top-level key like `name: value`.
 * Handles quoted and unquoted values.
 */
function extractScalar(yaml: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = yaml.match(re);
  if (!m) return undefined;
  return unquote(m[1].trim());
}

/** Remove surrounding quotes from a string value */
function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Extract the indented block under a key at a given indentation level.
 * Returns the raw lines (with original indentation) under that key.
 */
function extractBlock(lines: string[], key: string, baseIndent: number): string[] | null {
  const prefix = " ".repeat(baseIndent) + key + ":";
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === prefix || lines[i].startsWith(prefix + " ") || lines[i].startsWith(prefix + "\t")) {
      startIdx = i;
      break;
    }
    // Also handle case where key line has value on same line
    if (lines[i].trimStart().startsWith(key + ":") && getIndent(lines[i]) === baseIndent) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  const result: string[] = [];
  const childIndent = baseIndent + 2;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") { result.push(line); continue; }
    if (getIndent(line) < childIndent) break;
    result.push(line);
  }
  return result;
}

function getIndent(line: string): number {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

/**
 * Parse args block into Record<string, WorkflowArgDef>.
 * Expected structure (each line indented by argsIndent):
 *   version:
 *     required: true
 *   branch:
 *     default: main
 */
function parseArgs(lines: string[]): Record<string, WorkflowArgDef> {
  const args: Record<string, WorkflowArgDef> = {};
  let currentArg: string | null = null;
  let argIndent = -1;

  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = getIndent(line);
    const trimmed = line.trim();

    // Detect arg name line: `version:` or `branch:`
    if (argIndent === -1 || indent <= argIndent) {
      if (trimmed.endsWith(":")) {
        currentArg = trimmed.slice(0, -1);
        argIndent = indent;
        args[currentArg] = {};
        continue;
      }
    }

    // Property of current arg
    if (currentArg && indent > argIndent) {
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx !== -1) {
        const propKey = trimmed.slice(0, colonIdx).trim();
        const propVal = trimmed.slice(colonIdx + 1).trim();
        const def = args[currentArg];
        if (propKey === "required") {
          def.required = propVal === "true";
        } else if (propKey === "default") {
          def.default = unquote(propVal);
        } else if (propKey === "description") {
          def.description = unquote(propVal);
        }
      }
    }
  }
  return args;
}

/**
 * Parse the steps array block into WorkflowStep[].
 */
function parseSteps(lines: string[]): WorkflowStep[] {
  const steps: WorkflowStep[] = [];

  // Split into step chunks based on `- id:` pattern
  const stepChunks: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("- id:")) {
      if (current) stepChunks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) stepChunks.push(current);

  for (const chunk of stepChunks) {
    const step = parseOneStep(chunk);
    if (step) steps.push(step);
  }
  return steps;
}

function parseOneStep(chunk: string[]): WorkflowStep | null {
  const props: Record<string, string> = {};
  let multiLineKey: string | null = null;
  let multiLineLines: string[] = [];
  let multiLineBaseIndent = 0;
  let approvalPrompt: string | undefined;
  let approvalGoto: string | undefined;
  let approvalMaxRevisions: number | undefined;
  let inApprovalBlock = false;

  for (let i = 0; i < chunk.length; i++) {
    const line = chunk[i];
    const trimmed = line.trim();

    // If collecting multi-line value
    if (multiLineKey) {
      const indent = getIndent(line);
      if (trimmed === "" || indent > multiLineBaseIndent) {
        multiLineLines.push(trimmed);
        continue;
      } else {
        // End of multi-line block
        props[multiLineKey] = multiLineLines.join("\n");
        multiLineKey = null;
        multiLineLines = [];
      }
    }

    // First line: `- id: value`
    if (trimmed.startsWith("- ")) {
      const inner = trimmed.slice(2);
      const colonIdx = inner.indexOf(":");
      if (colonIdx !== -1) {
        const k = inner.slice(0, colonIdx).trim();
        const v = inner.slice(colonIdx + 1).trim();
        props[k] = unquote(v);
      }
      continue;
    }

    // Nested approval block
    if (trimmed === "approval:") {
      inApprovalBlock = true;
      continue;
    }
    if (inApprovalBlock) {
      const colonIdx2 = trimmed.indexOf(":");
      if (colonIdx2 !== -1) {
        const ak = trimmed.slice(0, colonIdx2).trim();
        const av = trimmed.slice(colonIdx2 + 1).trim();
        if (ak === "prompt") approvalPrompt = unquote(av);
        else if (ak === "goto") approvalGoto = unquote(av);
        else if (ak === "max_revisions") approvalMaxRevisions = parseInt(av, 10);
      }
      // Stay in approval block as long as lines are indented deeper than step level
      if (i + 1 < chunk.length) {
        const nextTrimmed = chunk[i + 1].trim();
        // If next line is a new top-level step property (not further indented under approval), exit block
        if (nextTrimmed && !nextTrimmed.startsWith("-") && getIndent(chunk[i + 1]) <= getIndent(chunk[1] ?? chunk[0])) {
          inApprovalBlock = false;
        }
      }
      continue;
    }

    // Regular property line
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx !== -1) {
      const k = trimmed.slice(0, colonIdx).trim();
      let v = trimmed.slice(colonIdx + 1).trim();

      // Multi-line `|` syntax
      if (v === "|") {
        multiLineKey = k;
        multiLineBaseIndent = getIndent(line);
        multiLineLines = [];
        continue;
      }

      props[k] = unquote(v);
    }
  }

  // Flush any remaining multi-line
  if (multiLineKey) {
    props[multiLineKey] = multiLineLines.join("\n");
  }

  const id = props.id;
  if (!id) return null;

  // Determine step type
  if (approvalPrompt !== undefined) {
    const approval: { prompt: string; goto?: string; max_revisions?: number } = { prompt: approvalPrompt };
    if (approvalGoto) approval.goto = approvalGoto;
    if (approvalMaxRevisions !== undefined && !isNaN(approvalMaxRevisions)) approval.max_revisions = approvalMaxRevisions;
    return { id, approval };
  }
  if (props.type === "llm" && props.prompt !== undefined) {
    return { id, type: "llm" as const, prompt: props.prompt };
  }
  if (props.command !== undefined) {
    const step: WorkflowStep = { id, command: props.command };
    if ("expect" in props) (step as any).expect = props.expect;
    if ("timeout" in props) (step as any).timeout = parseInt(props.timeout, 10);
    if ("output" in props) (step as any).output = props.output;
    return step;
  }

  return null;
}

/**
 * Parse a workflow definition from skill markdown content.
 * Returns null if no `workflow:` field exists in frontmatter.
 */
export function parseWorkflowFromSkill(content: string): WorkflowDefinition | null {
  const fm = extractFrontmatter(content);
  if (!fm) return null;

  const lines = fm.split("\n");

  // Check if workflow: key exists at top level
  const hasWorkflow = lines.some((l) => l.match(/^workflow:\s*$/));
  if (!hasWorkflow) return null;

  const name = extractScalar(fm, "name");
  if (!name) return null;

  // Extract workflow block (indented under `workflow:`)
  const workflowLines = extractBlock(lines, "workflow", 0);
  if (!workflowLines || workflowLines.length === 0) return null;

  // Extract args sub-block
  const argsLines = extractBlock(workflowLines, "args", 2);
  const args = argsLines ? parseArgs(argsLines) : {};

  // Extract steps sub-block
  const stepsLines = extractBlock(workflowLines, "steps", 2);
  const steps = stepsLines ? parseSteps(stepsLines) : [];

  // Extract on-failure scalar from workflow block
  let onFailure: string | undefined;
  for (const line of workflowLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("on-failure:")) {
      onFailure = unquote(trimmed.slice("on-failure:".length).trim());
      break;
    }
  }

  const def: WorkflowDefinition = { name, args, steps };
  if (onFailure) def.onFailure = onFailure;
  return def;
}

/**
 * Load a workflow definition from a skill file on disk.
 */
export function loadWorkflowFromFile(path: string): WorkflowDefinition | null {
  const content = readFileSync(path, "utf-8");
  return parseWorkflowFromSkill(content);
}
