# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Hub is an interactive **Chat Assistant** — a web-based chat interface with AI assistance. Supports both Claude Agent SDK and OpenAI-compatible API providers. Includes session persistence, user memory (FTS5), history compaction, per-session concurrency control, and per-request tools (memory save/delete with write-time dedup). Supports Lark (飞书) bot as an additional chat channel.

Planned: expose `POST /api/agent` for general-purpose agent execution, with n8n as the orchestration layer.

## Commands

```bash
npm run dev          # Start dev server with file watching (tsx)
npm run build        # TypeScript compile to dist/ + copy public/ and skills/
npm start            # Run compiled output
npm test             # Run tests once (vitest run)
npm run test:watch   # Run tests in watch mode
```

Run a single test file:
```bash
npx vitest run test/tools/bash-exec.test.ts
```

## Tech Stack

- **Runtime:** Node.js 22+, ESM modules
- **Language:** TypeScript 5.9 (strict mode, NodeNext module resolution)
- **Web framework:** Hono
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **AI:** Claude Agent SDK with MCP tools
- **Integrations:** Sentry (API query tool), GitHub (via `gh` CLI)
- **Validation:** Zod for env config and request schemas
- **Testing:** Vitest with in-memory SQLite

## Architecture

**Flow (Web):** Web UI → POST `/api/chat` → auth → session → slash commands → `handleConversation()` → provider.stream() → SSE (via `onEvent`) → save reply → EventLog audit

**Flow (Lark):** 飞书 webhook → POST `/api/lark/webhook` → dedup → fire-and-forget → send "思考中" card → `handleConversation()` → patch card with reply

**Providers:**
- `ClaudeProvider`: Uses Claude Agent SDK `query()` with MCP servers, supports session resume
- `GenericProvider`: Wraps any OpenAI-compatible API (e.g., DeepSeek) with multi-turn tool calling, token budget tracking, and context compaction

### Key modules:

| Module | Purpose |
|--------|---------|
| **Core** | |
| `src/server.ts` | App assembly, route registration, feature initialization |
| `src/env.ts` | Zod-validated environment config (cached singleton, `setEnv()` for tests) |
| `src/db.ts` | SQLite client creation (data/ directory), schema initialization + migration |
| `src/core/event-bus.ts` | `EventLog` — audit-only persistence, writes events to `event_log` table |
| `src/core/hub-event.ts` | `HubEvent` type definition and `createHubEvent()` factory |
| **Chat Assistant** | |
| `src/chat/conversation.ts` | `handleConversation()` — core conversation logic shared by Web and Lark channels |
| `src/chat/router.ts` | Web SSE adapter (`POST /api/chat`) — slash commands, heartbeat, delegates to `handleConversation()` |
| `src/chat/claude-provider.ts` | Claude Agent SDK provider with MCP server integration + session resume |
| `src/chat/generic-provider.ts` | OpenAI-compatible API provider with tool wrapping, token budget, compaction |
| `src/chat/setup.ts` | `setupChatProvider()` — provider factory based on env config |
| `src/chat/system-prompt.ts` | Builds 7-section system prompt (identity, safety, reasoning, tools, skills, knowledge, tool list) |
| `src/chat/auth.ts` | `chatAuthMiddleware()` — Bearer Token auth with anonymous fallback |
| `src/chat/commands.ts` | Slash command handling (/help, /reset, /list-skills, etc.) |
| `src/chat/compaction.ts` | `compactHistory()` — summarize + extract memories when history > 40 messages |
| `src/chat/types.ts` | `ChatProvider` interface, `ChatEvent` union type, `RequestTool` type |
| **Tools** | |
| `src/tools/types.ts` | `UnifiedToolDef` — single definition drives both MCP and OpenAI tool formats |
| `src/tools/register.ts` | Converts `UnifiedToolDef` to MCP tool + Generic ToolDef + prompt description |
| `src/tools/suite.ts` | `buildToolSuite()` — assembles full tool suite based on env vars |
| `src/tools/memory-save.ts` | Per-request `memory_save` tool with FTS5-based dedup hints |
| `src/tools/memory-delete.ts` | Per-request `memory_delete` tool with userId ownership check |
| `src/tools/sentry-query.ts` | Sentry API queries (issue details, latest event, stacktrace) |
| `src/tools/bash-exec.ts` | Sandboxed shell execution with timeout, output truncation, command allowlist |
| `src/tools/web-fetch.ts` | HTTP fetch + HTML→Markdown (Firecrawl or built-in), 15-min cache |
| `src/tools/web-search.ts` | Brave Search API wrapper with caching |
| `src/tools/claude-code.ts` | Delegates tasks to Claude Code CLI (sub-agent mode) |
| `src/tools/file-tools.ts` | `file_read` + `file_write` with `safePath()` sandbox validation |
| `src/tools/skill-reader.ts` | `get_skill` tool — on-demand skill content loading |
| **Skills** | |
| `src/skills/*.md` | Markdown skills with YAML frontmatter (name, description, tags, allowed-tools, requires-env, requires-bins) |
| `src/skills/loader.ts` | `scanSkillDirs()` — multi-dir scanner with eligibility checking, supports flat `*.md` + ClawHub `<name>/SKILL.md` format |
| `src/skills/frontmatter.ts` | `parseSkillFrontmatter()` — parses skill YAML frontmatter |
| `src/skills/eligibility.ts` | `checkEligibility()` — validates skill env/binary dependencies, filters unavailable skills |
| **Sessions & Memory** | |
| `src/sessions/manager.ts` | `SessionManager` — session CRUD, message append, provider session ID binding |
| `src/memory/manager.ts` | `MemoryManager` — FTS5 full-text search (CJK prefix matching), per-request memory injection |
| `src/memory/extractor.ts` | Extracts structured memories (preferences, decisions, facts) from conversations |
| **Lark Bot** | |
| `src/lark/client.ts` | Lark SDK wrapper, card send/patch helpers |
| `src/lark/router.ts` | Webhook handler (`POST /api/lark/webhook`), event dedup, fire-and-forget processing |

## Conventions

- All imports between source files use `.js` extension (NodeNext module resolution)
- SQLite database stored in `data/` directory (gitignored)
- Tests mirror `src/` structure under `test/`
- Tests use `createTestDb()` from `test/helpers.ts` for in-memory SQLite
- Environment is injected via `setEnv()` in tests, never reads `.env` directly in test code
- Commit messages follow `type: description` format (e.g., `feat:`, `fix:`, `docs:`, `chore:`)
