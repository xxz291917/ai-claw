# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Claw is an interactive **Chat Assistant** — a web-based chat interface with AI assistance. Supports multiple AI providers via a registry pattern (Claude Agent SDK, any OpenAI-compatible API). Includes session persistence, user memory (FTS5), history compaction, per-session concurrency control, per-request tools, and background subagent tasks. Multi-channel: Web (SSE) and Lark (飞书) bot.

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
- **Integrations:** Sentry (API query tool), GitHub (via `gh` CLI), Lark SDK
- **Validation:** Zod for env config and request schemas
- **Testing:** Vitest with in-memory SQLite

## Architecture

**Initialization:** `server.ts` → SubagentManager (lazy registry) → ToolSuite (with spawn) → setupChatProvider (registry + provider) → CronService → ChannelManager (Web + Lark) → startAll

**Flow (Web):** Web UI → WebChannel (`POST /api/chat`) → auth → session → slash commands → `handleConversation()` → provider.stream() → SSE (via `onEvent`) → save reply → EventLog audit

**Flow (Lark):** 飞书 webhook → LarkChannel (`POST /api/lark/webhook`) → dedup → fire-and-forget → send "思考中" card → `handleConversation()` → patch card with reply

**Providers (via ProviderRegistry):**
- `ClaudeProvider`: Uses Claude Agent SDK `query()` with MCP servers, supports session resume
- `GenericProvider`: Wraps any OpenAI-compatible API (e.g., DeepSeek) with multi-turn tool calling, token budget tracking, and context compaction
- Multiple providers can be registered via `PROVIDER_{NAME}_*` env vars

### Key modules:

| Module | Purpose |
|--------|---------|
| **Core** | |
| `src/server.ts` | App assembly — init DB, managers, tool suite, provider, channels |
| `src/env.ts` | Zod-validated environment config (cached singleton, `setEnv()` for tests) |
| `src/db.ts` | SQLite client creation (data/ directory), schema initialization + migration |
| `src/core/event-bus.ts` | `EventLog` — audit-only persistence, writes events to `event_log` table |
| `src/core/hub-event.ts` | `HubEvent` type definition and `createHubEvent()` factory |
| **Channels** | |
| `src/channels/types.ts` | `Channel` interface, `ChannelContext`, `InboundMessage`, `OnEventCallback` |
| `src/channels/manager.ts` | `ChannelManager` — register, startAll, stopAll, list |
| `src/channels/web.ts` | `WebChannel` — Web SSE adapter (`POST /api/chat`), slash commands, heartbeat |
| `src/channels/lark.ts` | `LarkChannel` — Lark webhook, event dedup, fire-and-forget card send/patch |
| **Chat Assistant** | |
| `src/chat/conversation.ts` | `handleConversation()` — core conversation logic shared by all channels |
| `src/chat/provider-registry.ts` | `ProviderRegistry`, `scanProviderEnvVars()`, `buildDefaultRegistry()` |
| `src/chat/claude-provider.ts` | Claude Agent SDK provider with MCP server integration + session resume |
| `src/chat/generic-provider.ts` | OpenAI-compatible API provider with tool wrapping, token budget, compaction |
| `src/chat/setup.ts` | `setupChatProvider()` — builds registry + creates active provider |
| `src/chat/system-prompt.ts` | Builds 7-section system prompt (identity, safety, reasoning, tools, skills, knowledge, tool list) |
| `src/chat/auth.ts` | `chatAuthMiddleware()` — Bearer Token auth with anonymous fallback |
| `src/chat/commands.ts` | Slash command handling (/help, /reset, /skills, /tasks, /stop, etc.) |
| `src/chat/compaction.ts` | `compactHistory()` — summarize + extract memories when history exceeds token budget |
| `src/chat/types.ts` | `ChatProvider` interface, `ChatEvent` union type, `RequestTool` type |
| **Subagent** | |
| `src/subagent/manager.ts` | `SubagentManager` — spawn background tasks, cancel, list, result reporting |
| **Tools** | |
| `src/tools/types.ts` | `UnifiedToolDef` — single definition drives both MCP and OpenAI tool formats |
| `src/tools/register.ts` | Converts `UnifiedToolDef` to MCP tool + Generic ToolDef + prompt description |
| `src/tools/suite.ts` | `buildToolSuite()` — assembles full tool suite based on env vars |
| `src/tools/spawn.ts` | `spawn` tool — delegates background tasks to SubagentManager |
| `src/tools/memory-save.ts` | Per-request `memory_save` tool with FTS5-based dedup hints |
| `src/tools/memory-delete.ts` | Per-request `memory_delete` tool with userId ownership check |
| `src/tools/sentry-query.ts` | Sentry API queries (issue details, latest event, stacktrace) |
| `src/tools/bash-exec.ts` | Sandboxed shell execution with timeout, output truncation, command allowlist |
| `src/tools/web-fetch.ts` | HTTP fetch + HTML→Markdown (Firecrawl or built-in), 15-min cache |
| `src/tools/web-search.ts` | Brave Search API wrapper with caching |
| `src/tools/claude-code.ts` | Delegates tasks to Claude Code CLI (sub-agent mode) |
| `src/tools/file-tools.ts` | `file_read` + `file_write` with `safePath()` sandbox validation |
| ~~`src/tools/skill-reader.ts`~~ | Removed — skills loaded via `file_read` + XML `<location>` in system prompt |
| **Skills** | |
| `src/skills/*.md` | Markdown skills with YAML frontmatter (name, description, tags, allowed-tools, requires-env, requires-bins) |
| `src/skills/loader.ts` | `scanSkillDirs()` — multi-dir scanner with eligibility checking, supports flat `*.md` + ClawHub `<name>/SKILL.md` format |
| `src/skills/frontmatter.ts` | `parseSkillFrontmatter()` — parses skill YAML frontmatter |
| `src/skills/eligibility.ts` | `checkEligibility()` — validates skill env/binary dependencies, filters unavailable skills |
| **Sessions & Memory** | |
| `src/sessions/manager.ts` | `SessionManager` — session CRUD, message append, incremental compaction, provider session ID binding |
| `src/memory/manager.ts` | `MemoryManager` — FTS5 full-text search (CJK prefix matching), per-request memory injection |
| `src/memory/extractor.ts` | Extracts structured memories (preferences, decisions, facts) from conversations |
| **Cron** | |
| `src/cron/types.ts` | Schedule types (at/every/cron), CronJob, CronPayload definitions |
| `src/cron/schedule.ts` | `computeNextRunAt()` using `croner` library, LRU-cached parsing |
| `src/cron/store.ts` | SQLite CRUD for cron_jobs table with prepared statements |
| `src/cron/service.ts` | `CronService` — scheduler engine with timer rearm, backoff, max 3 concurrent |
| `src/cron/commands.ts` | `/cron` slash commands (list, add, remove, enable, disable, run) |
| **Lark** | |
| `src/lark/client.ts` | Lark SDK wrapper, card send/patch helpers |

## Deployment

Multi-stage Docker build (`Dockerfile`):
- **Builder stage:** node:22-slim + build tools (python3/make/g++) for native modules → `npm ci` → `tsc` → `npm prune --omit=dev`
- **Production stage:** node:22-slim + pm2 globally → copies pre-built `node_modules/` + `dist/` from builder
- Non-root user `aiclaw` (uid 1001) required by Claude provider
- CMD: `pm2-runtime ecosystem.config.cjs`

```bash
docker build -t ai-claw .
docker run -d -p 3000:3000 --env-file .env -v $(pwd)/data:/app/data ai-claw
```

## Conventions

- All imports between source files use `.js` extension (NodeNext module resolution)
- SQLite database stored in `data/` directory (gitignored)
- Tests mirror `src/` structure under `test/`
- Tests use `createTestDb()` from `test/helpers.ts` for in-memory SQLite
- Environment is injected via `setEnv()` in tests, never reads `.env` directly in test code
- Commit messages follow `type: description` format (e.g., `feat:`, `fix:`, `docs:`, `chore:`)
- Skills use system-registered tool names in `allowed-tools` (e.g., `bash_exec`, `file_read`, `web_fetch` — not informal aliases like `Bash`, `Read`)
- Prefix skill files/directories with `_` to disable them (loader skips `_`-prefixed entries)
- Skills that depend on MCP tools (e.g., `notion-rag__search`) should include availability guards in their instructions
