# Lightweight File Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 6 lightweight file tools (read, write, edit, grep, glob, patch) to GenericProvider so DeepSeek can directly manipulate files without spawning Claude Code CLI.

**Architecture:** Single `file-tools.ts` module exports `createFileTools(config)` returning `ToolDef[]`. All tools share a `safePath()` sandbox function restricting operations to `workspaceDir`. Integrated via `genericTools.push(...fileTools)` in server.ts.

**Tech Stack:** Node.js fs/path APIs, `fast-glob` for glob (already available via vitest), `child_process` not needed.

**Design doc:** `docs/plans/2026-02-18-lightweight-file-tools-design.md`

---

### Task 1: safePath + file_read + file_write (core foundation)

**Files:**
- Create: `src/agent/tools/file-tools.ts`
- Create: `test/agent/tools/file-tools.test.ts`

**Step 1: Write failing tests for safePath**

```typescript
// test/agent/tools/file-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Will import createFileTools + safePath after implementation
let workspace: string;

beforeEach(() => {
  workspace = resolve(tmpdir(), `file-tools-test-${randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("safePath", () => {
  it("resolves relative path within workspace", () => { ... });
  it("rejects path traversal with ../", () => { ... });
  it("rejects absolute path outside workspace", () => { ... });
});

describe("file_read", () => {
  it("reads file with line numbers", () => { ... });
  it("supports offset and limit pagination", () => { ... });
  it("returns error for nonexistent file", () => { ... });
  it("rejects path outside workspace", () => { ... });
});

describe("file_write", () => {
  it("creates new file", () => { ... });
  it("creates parent directories", () => { ... });
  it("overwrites existing file", () => { ... });
  it("rejects path outside workspace", () => { ... });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/agent/tools/file-tools.test.ts`
Expected: FAIL — module not found

**Step 3: Implement safePath, file_read, file_write**

```typescript
// src/agent/tools/file-tools.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import type { ToolDef } from "../chat/generic-provider.js";

export type FileToolsConfig = {
  workspaceDir: string;
  maxReadBytes?: number;    // default 50000
  maxGrepResults?: number;  // default 50
};

export function safePath(userPath: string, workspaceDir: string): string {
  const resolved = resolve(workspaceDir, userPath);
  if (!resolved.startsWith(workspaceDir + "/") && resolved !== workspaceDir) {
    throw new Error(`Path outside workspace: ${userPath}`);
  }
  return resolved;
}

export function createFileTools(config: FileToolsConfig): ToolDef[] {
  const ws = resolve(config.workspaceDir);
  const maxRead = config.maxReadBytes ?? 50_000;
  // ... return array of ToolDef for all 6 tools
}
```

Key behaviors:
- `file_read`: `readFileSync` → split lines → add line numbers → respect offset/limit → truncate at maxReadBytes
- `file_write`: `mkdirSync(dirname, { recursive: true })` → `writeFileSync`
- Both use `safePath()` for all path resolution

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/agent/tools/file-tools.test.ts`
Expected: PASS (11 tests)

**Step 5: Commit**

```bash
git add src/agent/tools/file-tools.ts test/agent/tools/file-tools.test.ts
git commit -m "feat(tools): add safePath, file_read, file_write tools"
```

---

### Task 2: file_edit

**Files:**
- Modify: `src/agent/tools/file-tools.ts`
- Modify: `test/agent/tools/file-tools.test.ts`

**Step 1: Write failing tests**

```typescript
describe("file_edit", () => {
  it("replaces unique match", () => { ... });
  it("returns error when old_text not found", () => { ... });
  it("returns error when old_text matches multiple times", () => { ... });
  it("preserves rest of file content", () => { ... });
  it("rejects path outside workspace", () => { ... });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/agent/tools/file-tools.test.ts`
Expected: FAIL — file_edit not defined

**Step 3: Implement file_edit**

Logic:
1. `safePath(path, ws)` → read file
2. `content.indexOf(old_text)` — if -1 → error "old_text not found"
3. Check `content.indexOf(old_text, firstIdx + 1)` — if found → error "old_text matches multiple times, add more context"
4. `content.slice(0, idx) + new_text + content.slice(idx + old_text.length)` → write back

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/agent/tools/file-tools.test.ts`
Expected: PASS (16 tests)

**Step 5: Commit**

```bash
git add src/agent/tools/file-tools.ts test/agent/tools/file-tools.test.ts
git commit -m "feat(tools): add file_edit search/replace tool"
```

---

### Task 3: file_grep + file_glob

**Files:**
- Modify: `src/agent/tools/file-tools.ts`
- Modify: `test/agent/tools/file-tools.test.ts`

**Step 1: Write failing tests**

```typescript
describe("file_grep", () => {
  it("finds regex matches across files", () => { ... });
  it("respects glob filter", () => { ... });
  it("limits results to maxGrepResults", () => { ... });
  it("returns error for invalid regex", () => { ... });
  it("rejects path outside workspace", () => { ... });
});

describe("file_glob", () => {
  it("matches files by pattern", () => { ... });
  it("returns relative paths", () => { ... });
  it("rejects path outside workspace", () => { ... });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/agent/tools/file-tools.test.ts`
Expected: FAIL

**Step 3: Implement file_grep and file_glob**

`file_grep` implementation:
1. Resolve search path via `safePath` (default: workspace root)
2. Use `readdirSync` recursive to collect files (respecting glob filter if provided)
3. For each file: `readFileSync` → split lines → `regex.test(line)` → collect `{file, line, content}`
4. Cap at `maxGrepResults`, return formatted output

`file_glob` implementation:
1. Resolve base path via `safePath`
2. Use Node.js `globSync` from `node:fs` (Node 22+) or `readdirSync` with pattern matching
3. Return relative paths from workspace

Note: Node 22 has `fs.globSync` built-in. If not available, implement with `readdirSync` + minimatch-style filtering. Check availability first.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/agent/tools/file-tools.test.ts`
Expected: PASS (24 tests)

**Step 5: Commit**

```bash
git add src/agent/tools/file-tools.ts test/agent/tools/file-tools.test.ts
git commit -m "feat(tools): add file_grep and file_glob tools"
```

---

### Task 4: file_patch

**Files:**
- Modify: `src/agent/tools/file-tools.ts`
- Modify: `test/agent/tools/file-tools.test.ts`

**Step 1: Write failing tests**

```typescript
describe("file_patch", () => {
  it("applies a simple unified diff", () => { ... });
  it("returns error for malformed patch", () => { ... });
  it("returns error when context does not match", () => { ... });
  it("rejects path outside workspace", () => { ... });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/agent/tools/file-tools.test.ts`
Expected: FAIL

**Step 3: Implement file_patch**

Implementation approach: parse unified diff format manually (no external dep).

1. Parse `@@ -start,count +start,count @@` headers
2. For each hunk: verify context lines match, apply removals (`-`) and additions (`+`)
3. Write result back to file

This is the most complex tool. Keep the parser minimal — support single-file patches only. If the patch is malformed, return a clear error suggesting `file_edit` as fallback.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/agent/tools/file-tools.test.ts`
Expected: PASS (28 tests)

**Step 5: Commit**

```bash
git add src/agent/tools/file-tools.ts test/agent/tools/file-tools.test.ts
git commit -m "feat(tools): add file_patch unified diff tool"
```

---

### Task 5: Wire into server.ts + update system prompt

**Files:**
- Modify: `src/server.ts:301` (after bash_exec registration, before claude_code)
- Modify: `src/chat/system-prompt.ts:63-97` (tool usage guidelines section)

**Step 1: Register file tools in server.ts**

Add import at top:
```typescript
import { createFileTools } from "./agent/tools/file-tools.js";
```

Add after bash_exec registration block (around line 301), before claude_code:
```typescript
  // file tools (always available — lightweight file operations)
  const fileTools = createFileTools({ workspaceDir: env.WORKSPACE_DIR });
  for (const ft of fileTools) {
    genericTools.push(ft);
    chatToolDescriptions.push(
      `\`${ft.name}(${Object.keys(ft.parameters.properties ?? {}).join(", ")})\` — ${ft.description}`
    );
  }
```

Note: Each tool in the `ToolDef[]` returned by `createFileTools` must include the `parameters` field with `type: "object"`, `properties`, and `required` — same shape as existing tools in server.ts.

**Step 2: Update system-prompt.ts tool guidance**

Replace the `### bash_exec` and `### claude_code` sections with:

```
### File tools (preferred for code tasks)
- Use `file_read`, `file_write`, `file_edit`, `file_grep`, `file_glob`, `file_patch` for all file operations. These are fast, reliable, and sandboxed to the workspace.
- `file_read` returns content with line numbers. Use `offset` and `limit` for large files.
- `file_edit` uses search/replace — the `old_text` must match exactly once. Include enough context to be unique.
- `file_grep` supports regex. Use `glob` parameter to filter file types (e.g. "*.ts").
- `file_patch` accepts unified diff format. For simple changes, prefer `file_edit`.

### bash_exec
- Use `bash_exec` for shell commands (git, gh, curl, npm, sqlite3, etc.).
- For file reading/editing, prefer file tools over bash (cat, sed, awk).
- Commands run in the workspace directory by default.

### claude_code (heavy sub-agent — use sparingly)
- Only use `claude_code` for complex multi-file refactoring, tasks requiring deep code understanding, or autonomous test-and-iterate cycles.
- It spawns a full Claude Code process (slow, 2-5 min). Prefer file tools for single-file edits.
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (180+ tests)

**Step 4: Commit**

```bash
git add src/server.ts src/chat/system-prompt.ts
git commit -m "feat(tools): wire file tools into server and update system prompt"
```

---

### Task 6: End-to-end verification

**Step 1: Build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 3: Manual smoke test (optional)**

Start dev server, open chat, ask DeepSeek to:
1. "读取 src/env.ts 的内容" → should use `file_read`
2. "在 src/env.ts 中找到 PORT 的定义" → should use `file_grep`
3. "找到所有 .test.ts 文件" → should use `file_glob`

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(tools): address issues found in smoke testing"
```
