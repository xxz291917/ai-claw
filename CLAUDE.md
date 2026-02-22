# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Hub provides two main features:

1. **Fault Healing Pipeline:** Automated bug fixing triggered by Sentry alerts. Receives webhooks, uses Claude Agent SDK (batch mode) to analyze and fix issues, records results to DB. Agent runs autonomously — no state machine or approval gates. (Planned: migrate orchestration to n8n, expose `POST /api/agent`.)

2. **Chat Assistant:** Interactive web-based chat interface with AI assistance. Supports both Claude Agent SDK and OpenAI-compatible API providers. Includes session persistence, user memory (FTS5), history compaction, and per-session concurrency control.

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
- **Integrations:** Sentry (webhooks + API), Lark/飞书 (notification cards), GitHub (via `gh` CLI)
- **Validation:** Zod for env config and request schemas
- **Testing:** Vitest with in-memory SQLite

## Architecture

The application adopts an **Agent Autonomy** model: LLM agents use tools + skills to complete workflows independently. The system handles triggering, audit logging, and result recording — no orchestration layer, state machines, or adapters.

Both features conditionally initialize based on environment variables:
- **Fault Healing Pipeline** requires: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `ANTHROPIC_API_KEY`, `GH_TOKEN`
- **Chat Assistant** always available; uses Claude Agent SDK by default or a generic OpenAI-compatible provider if `CHAT_PROVIDER=generic`

### Fault Healing Pipeline

**Flow:** Sentry webhook → Zod validation → dedup check → create task (status=running) → fire-and-forget `runAgent()` → task status updated to done/failed

Task states are simple: `running` / `done` / `failed` (no state machine).

### Chat Assistant

**Flow:** Web UI → POST `/api/chat` → auth → session → slash commands → history + memory → compactHistory → provider.stream() → SSE → save reply → EventLog audit

**Providers:**
- `ClaudeProvider`: Uses Claude Agent SDK `query()` with MCP servers, supports session resume
- `GenericProvider`: Wraps any OpenAI-compatible API (e.g., DeepSeek) with multi-turn tool calling, token budget tracking, and context compaction

### Key modules:

| Module | Purpose |
|--------|---------|
| **Core** | |
| `src/server.ts` | App assembly, route registration, conditional feature initialization |
| `src/env.ts` | Zod-validated environment config (cached singleton, `setEnv()` for tests) |
| `src/db.ts` | SQLite client creation (data/ directory), schema initialization + migration |
| `src/core/event-bus.ts` | `EventLog` — audit-only persistence, writes events to `event_log` table |
| `src/core/hub-event.ts` | `HubEvent` type definition and `createHubEvent()` factory |
| **Fault Healing** | |
| `src/routes/webhooks.ts` | Sentry webhook endpoint with Zod validation, dedup, task creation, fire-and-forget agent call |
| `src/agent/runner.ts` | `runAgent()` — batch-mode Claude Agent SDK execution, returns `AgentResult` |
| `src/lark/notify.ts` | Builds notification cards (non-interactive), sends to Lark group chat |
| **Chat Assistant** | |
| `src/chat/router.ts` | SSE-based chat endpoint (`POST /api/chat`) with session, memory, concurrency lock |
| `src/chat/claude-provider.ts` | Claude Agent SDK provider with MCP server integration + session resume |
| `src/chat/generic-provider.ts` | OpenAI-compatible API provider with tool wrapping, token budget, compaction |
| `src/chat/setup.ts` | `setupChatProvider()` — provider factory based on env config |
| `src/chat/system-prompt.ts` | Builds 7-section system prompt (identity, safety, reasoning, tools, skills, knowledge, tool list) |
| `src/chat/auth.ts` | `chatAuthMiddleware()` — Bearer Token auth with anonymous fallback |
| `src/chat/commands.ts` | Slash command handling (/help, /reset, /list-skills, etc.) |
| `src/chat/compaction.ts` | `compactHistory()` — summarize + extract memories when history > 40 messages |
| `src/chat/types.ts` | `ChatProvider` interface, `ChatEvent` union type |
| **Tools** | |
| `src/tools/types.ts` | `UnifiedToolDef` — single definition drives both MCP and OpenAI tool formats |
| `src/tools/register.ts` | Converts `UnifiedToolDef` to MCP tool + Generic ToolDef + prompt description |
| `src/tools/suite.ts` | `buildToolSuite()` — assembles full tool suite based on env vars, shared by Chat and Fault Healing |
| `src/tools/sentry-query.ts` | Sentry API queries (issue details, latest event, stacktrace) |
| `src/tools/bash-exec.ts` | Sandboxed shell execution with timeout, output truncation, command allowlist |
| `src/tools/web-fetch.ts` | HTTP fetch + HTML→Markdown (Firecrawl or built-in), 15-min cache |
| `src/tools/web-search.ts` | Brave Search API wrapper with caching |
| `src/tools/claude-code.ts` | Delegates tasks to Claude Code CLI (sub-agent mode) |
| `src/tools/file-tools.ts` | `file_read` + `file_write` with `safePath()` sandbox validation |
| `src/tools/skill-reader.ts` | `get_skill` tool — on-demand skill content loading |
| **Skills** | |
| `src/skills/*.md` | Markdown skills with YAML frontmatter (name, description, tags, allowed-tools) |
| `src/skills/frontmatter.ts` | `parseSkillFrontmatter()` — parses skill YAML frontmatter |
| **Sessions & Memory** | |
| `src/sessions/manager.ts` | `SessionManager` — session CRUD, message append, provider session ID binding |
| `src/memory/manager.ts` | `MemoryManager` — FTS5 full-text search (CJK prefix matching), per-request memory injection |
| `src/memory/extractor.ts` | Extracts structured memories (preferences, decisions, facts) from conversations |

## Conventions

- All imports between source files use `.js` extension (NodeNext module resolution)
- SQLite database stored in `data/` directory (gitignored)
- Tests mirror `src/` structure under `test/`
- Tests use `createTestDb()` from `test/helpers.ts` for in-memory SQLite
- Environment is injected via `setEnv()` in tests, never reads `.env` directly in test code
- Agent execution is fire-and-forget from route handlers
- Both features (fault healing + chat) conditionally initialize based on required env vars
- Commit messages follow `type: description` format (e.g., `feat:`, `fix:`, `docs:`, `chore:`)
