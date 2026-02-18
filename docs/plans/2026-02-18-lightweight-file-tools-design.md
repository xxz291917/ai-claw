# Lightweight File Tools for GenericProvider

**Date:** 2026-02-18
**Status:** Approved

## Problem

GenericProvider (DeepSeek) lacks direct file operation tools. Code modification currently requires either unreliable `bash_exec sed` or spawning a full Claude Code CLI subprocess (`claude_code`) which takes 5+ minutes, causes SSE connection drops, and adds unnecessary cost.

OpenClaw solves this by exposing native read/write/edit tools directly to the LLM — no intermediate agent process.

## Decision

Add 6 lightweight file tools in a single `src/agent/tools/file-tools.ts` file (Approach B). Keep `claude_code` as a fallback for complex multi-file tasks, but demote it in system prompt guidance.

## Tool Definitions

| Tool | Parameters | Behavior |
|------|-----------|----------|
| `file_read` | `path`, `offset?`, `limit?` | Read file with line numbers. Paginated. Max 50KB per call. |
| `file_write` | `path`, `content` | Create or overwrite file. Auto-creates parent directories. |
| `file_edit` | `path`, `old_text`, `new_text` | Search/replace. `old_text` must match exactly once. |
| `file_grep` | `pattern`, `path?`, `glob?` | Regex search file contents. Max 50 matches. |
| `file_glob` | `pattern`, `path?` | Glob pattern file matching. Returns path list. |
| `file_patch` | `path`, `patch` | Apply unified diff patch. |

## Security Model

All tools share a `safePath(userPath, workspaceDir)` function:

1. `resolve(workspaceDir, userPath)` to get absolute path
2. Verify resolved path starts with `workspaceDir`
3. Reject `../` traversal, symlink escape, absolute path outside workspace
4. Return resolved path or throw error

`bash_exec` remains unrestricted (general-purpose tool). File tools are sandboxed to workspace only.

## Configuration

```typescript
type FileToolsConfig = {
  workspaceDir: string;     // Sandbox root
  maxReadBytes?: number;    // Default 50000 (50KB)
  maxGrepResults?: number;  // Default 50
};
```

Exported factory: `createFileTools(config): ToolDef[]` returns all 6 tools.

## Integration

### server.ts

One-line registration:

```typescript
const fileTools = createFileTools({ workspaceDir: env.WORKSPACE_DIR });
genericTools.push(...fileTools);
```

### system-prompt.ts

Demote `claude_code`, promote file tools:

> **File operations: use lightweight tools first** — `file_read`, `file_write`, `file_edit`, `file_grep`, `file_glob`, `file_patch`. These are fast and reliable.
>
> **Only use `claude_code` for**: complex multi-file refactoring, tasks requiring deep code understanding, or tasks that need autonomous test-and-iterate cycles.

### Tool descriptions (for system prompt)

```
`file_read(path, offset?, limit?)` — Read file contents with line numbers
`file_write(path, content)` — Create or overwrite a file
`file_edit(path, old_text, new_text)` — Search/replace edit (old_text must be unique)
`file_grep(pattern, path?, glob?)` — Regex search file contents
`file_glob(pattern, path?)` — Find files by glob pattern
`file_patch(path, patch)` — Apply a unified diff patch
```

## Testing

- `test/agent/tools/file-tools.test.ts`
- Temp directory as workspace, cleaned up after each test
- 3-5 tests per tool: normal operation, path traversal rejection, edge cases
- ~25-30 tests total

## Files Changed

| File | Change |
|------|--------|
| `src/agent/tools/file-tools.ts` | **New** — all 6 tools + `safePath` + `createFileTools` |
| `src/server.ts` | Register file tools in genericTools array |
| `src/chat/system-prompt.ts` | Update tool guidance (demote claude_code, promote file tools) |
| `test/agent/tools/file-tools.test.ts` | **New** — comprehensive tests |
