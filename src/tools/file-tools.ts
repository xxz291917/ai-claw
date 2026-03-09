import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { z } from "zod";
import type { UnifiedToolDef } from "./types.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export type FileToolsConfig = {
  workspaceDir: string;
  maxReadBytes?: number; // default 50000
  maxGrepResults?: number; // default 50
};

// ---------------------------------------------------------------------------
// Sensitive file blocklist
// ---------------------------------------------------------------------------
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
  /^\.netrc$/,
  /^\.npmrc$/,
  /^credentials\.json$/i,
  /^secrets?\./i,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
];

function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);
  return SENSITIVE_PATTERNS.some((p) => p.test(name));
}

// ---------------------------------------------------------------------------
// safePath — security sandbox
// ---------------------------------------------------------------------------
/**
 * Resolve `userPath` against `workspaceDir` and verify it stays within the
 * workspace boundary. Also blocks access to sensitive files (.env, keys, etc.).
 * Throws if the resolved path escapes or targets a sensitive file.
 */
export function safePath(userPath: string, workspaceDir: string): string {
  const resolved = resolve(workspaceDir, userPath);
  if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + "/")) {
    throw new Error(`Path outside workspace: ${userPath}`);
  }
  if (isSensitiveFile(resolved)) {
    throw new Error(`Access denied: ${basename(resolved)} is a sensitive file`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// createFileTools — factory
// ---------------------------------------------------------------------------
export function createFileTools(config: FileToolsConfig): UnifiedToolDef[] {
  // Resolve workspace with fallback (same strategy as bash_exec)
  let workspaceDir = resolve(config.workspaceDir);
  if (!existsSync(workspaceDir)) {
    log.warn(`[file_tools] workspace "${workspaceDir}" does not exist, falling back to process.cwd(): ${process.cwd()}`);
    workspaceDir = process.cwd();
  }
  const maxReadBytes = config.maxReadBytes ?? 50_000;

  // -----------------------------------------------------------------------
  // file_read
  // -----------------------------------------------------------------------
  const fileRead: UnifiedToolDef = {
    name: "file_read",
    description:
      "Read a file from the workspace and return its contents with line numbers. " +
      "Supports pagination via offset (0-based line offset) and limit (max lines).",
    inputSchema: {
      path: z.string().describe("File path relative to workspace"),
      offset: z.number().optional().describe("Line offset (0-based, default 0)"),
      limit: z.number().optional().describe("Max lines to return"),
    },
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace" },
        offset: { type: "number", description: "Line offset (0-based, default 0)" },
        limit: { type: "number", description: "Max lines to return" },
      },
      required: ["path"],
    },
    execute: async (args: { path: string; offset?: number; limit?: number }, _ctx) => {
      let absPath: string;
      try {
        absPath = safePath(args.path, workspaceDir);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }

      let raw: string;
      try {
        raw = readFileSync(absPath, "utf-8");
      } catch (err: any) {
        return `Error reading file: ${err.message}`;
      }

      const allLines = raw.split("\n");
      const offset = args.offset ?? 0;
      const limit = args.limit ?? allLines.length;
      const sliced = allLines.slice(offset, offset + limit);

      const maxLineNo = offset + sliced.length;
      const numWidth = String(maxLineNo).length;

      let output = sliced
        .map((line, i) => {
          const lineNo = String(offset + i + 1).padStart(numWidth, " ");
          return `${lineNo}| ${line}`;
        })
        .join("\n");

      if (output.length > maxReadBytes) {
        output =
          output.slice(0, maxReadBytes) +
          `\n[...truncated at ${maxReadBytes} bytes]`;
      }

      return output;
    },
  };

  // -----------------------------------------------------------------------
  // file_write
  // -----------------------------------------------------------------------
  const fileWrite: UnifiedToolDef = {
    name: "file_write",
    description:
      "Write content to a file in the workspace. Creates parent directories if needed. " +
      "Overwrites the file if it already exists.",
    inputSchema: {
      path: z.string().describe("File path relative to workspace"),
      content: z.string().describe("Content to write to the file"),
    },
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
    execute: async (args: { path: string; content: string }, _ctx) => {
      let absPath: string;
      try {
        absPath = safePath(args.path, workspaceDir);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }

      try {
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, args.content);
        return `Wrote ${args.content.length} bytes to ${args.path}`;
      } catch (err: any) {
        return `Error writing file: ${err.message}`;
      }
    },
  };

  return [fileRead, fileWrite];
}
