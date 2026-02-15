# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Hub provides two main features:

1. **Fault Healing Pipeline:** Automated bug fixing triggered by Sentry alerts. Receives webhooks, uses Claude Agent SDK to analyze and fix issues, sends interactive Lark (飞书) cards for human approval, and creates PRs.

2. **Chat Assistant:** Interactive web-based chat interface with AI assistance. Supports both Claude Agent SDK and OpenAI-compatible API providers.

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
npx vitest run test/tasks/store.test.ts
```

## Tech Stack

- **Runtime:** Node.js 22+, ESM modules
- **Language:** TypeScript 5.9 (strict mode)
- **Web framework:** Hono
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **AI:** Claude Agent SDK with MCP tools
- **Integrations:** Sentry (webhooks + API), Lark (cards + callbacks), GitHub (via `gh` CLI)
- **Validation:** Zod for env config and request schemas
- **Testing:** Vitest with in-memory SQLite

## Architecture

The application initializes both features conditionally based on environment variables:
- **Fault Healing Pipeline** requires: Sentry, Lark, GitHub, and Claude API credentials
- **Chat Assistant** always available; uses Claude Agent SDK by default or a generic OpenAI-compatible provider if configured

### Fault Healing Pipeline

**Flow:** Sentry webhook → Task creation → AI analysis → Lark diagnosis card → Human approval → AI fix → PR creation → Lark PR card → Merge/reject

**Task state machine** (`src/tasks/types.ts`):
```
pending → analyzing → reported → fixing → pr_ready → merged → done
              ↓            ↓         ↓         ↓
            failed      ignored    failed    rejected
```

### Chat Assistant

**Flow:** Web UI → POST `/api/chat` → SSE streaming → Chat provider (Claude or Generic) → MCP tools → Response

**Providers:**
- `ClaudeProvider`: Uses Claude Agent SDK with MCP servers for tool integration
- `GenericProvider`: Wraps any OpenAI-compatible API (e.g., DeepSeek) with simplified tool calling

### Key modules:

| Module | Purpose |
|--------|---------|
| **Core** | |
| `src/server.ts` | App assembly, route registration, conditional feature initialization |
| `src/env.ts` | Zod-validated environment config (cached singleton, `setEnv()` for tests) |
| `src/db.ts` | SQLite client creation (data/ directory) and schema initialization |
| **Fault Healing** | |
| `src/workflows/fault-healing.ts` | Orchestrates the full analysis → fix lifecycle |
| `src/webhooks/sentry.ts` | Sentry webhook endpoint with deduplication |
| `src/tasks/store.ts` | SQLite-backed task CRUD with state transition validation |
| `src/tasks/types.ts` | Task state machine definition (states, events, transitions) |
| `src/lark/notify.ts` | Builds and sends interactive Lark cards |
| `src/lark/callback.ts` | Handles Lark card button click callbacks |
| **Chat Assistant** | |
| `src/chat/router.ts` | SSE-based chat endpoint (`POST /api/chat`) |
| `src/chat/claude-provider.ts` | Claude Agent SDK provider with MCP server integration |
| `src/chat/generic-provider.ts` | OpenAI-compatible API provider with tool wrapping |
| `src/chat/system-prompt.ts` | Builds rich system prompt with project knowledge + skills |
| `src/public/index.html` | Static chat UI (served at `/`) |
| **AI Agent** | |
| `src/agent/runner.ts` | Wraps Claude Agent SDK execution with MCP server config |
| `src/agent/tools/sentry-query.ts` | Custom MCP tool for Sentry API queries |
| `src/agent/tools/skill-reader.ts` | Custom MCP tool for on-demand skill loading (`get_skill`) |
| `src/skills/*.md` | System prompts and skill instructions loaded into agents |

## Conventions

- All imports between source files use `.js` extension (NodeNext module resolution)
- SQLite database stored in `data/` directory (gitignored)
- Tests mirror `src/` structure under `test/`
- Tests use `createTestDb()` from `test/helpers.ts` for in-memory SQLite
- Environment is injected via `setEnv()` in tests, never reads `.env` directly in test code
- Workflow methods are async and called fire-and-forget from route handlers
- Both features (fault healing + chat) conditionally initialize based on required env vars
- Commit messages follow `type: description` format (e.g., `feat:`, `fix:`, `docs:`, `chore:`)
