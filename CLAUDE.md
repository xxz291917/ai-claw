# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI Hub is an AI-driven fault healing service. It receives Sentry alerts via webhooks, uses Claude Agent SDK to analyze and fix issues, sends interactive Lark (飞书) cards for human approval, and creates PRs.

## Commands

```bash
npm run dev          # Start dev server with file watching (tsx)
npm run build        # TypeScript compile to dist/
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

**Pipeline flow:** Sentry webhook → Task creation → AI analysis → Lark diagnosis card → Human approval → AI fix → PR creation → Lark PR card → Merge/reject

**Task state machine** (`src/tasks/types.ts`):
```
pending → analyzing → reported → fixing → pr_ready → merged → done
              ↓            ↓         ↓         ↓
            failed      ignored    failed    rejected
```

**Key modules:**

| Module | Purpose |
|--------|---------|
| `src/server.ts` | Hono app assembly, route registration, dependency wiring |
| `src/workflows/fault-healing.ts` | Orchestrates the full analysis → fix lifecycle |
| `src/agent/runner.ts` | Wraps Claude Agent SDK execution with MCP server config |
| `src/agent/tools/sentry-query.ts` | Custom MCP tool for Sentry API queries |
| `src/tasks/store.ts` | SQLite-backed task CRUD with state transition validation |
| `src/tasks/types.ts` | Task state machine definition (states, events, transitions) |
| `src/lark/notify.ts` | Builds and sends interactive Lark cards |
| `src/lark/callback.ts` | Handles Lark card button click callbacks |
| `src/webhooks/sentry.ts` | Sentry webhook endpoint with deduplication |
| `src/skills/fault-healing.md` | System prompt loaded into the AI agent |
| `src/env.ts` | Zod-validated environment config (cached singleton, `setEnv()` for tests) |
| `src/db.ts` | SQLite client creation and schema initialization |

## Conventions

- All imports between source files use `.js` extension (NodeNext module resolution)
- Tests mirror `src/` structure under `test/`
- Tests use `createTestDb()` from `test/helpers.ts` for in-memory SQLite
- Environment is injected via `setEnv()` in tests, never reads `.env` directly in test code
- Workflow methods are async and called fire-and-forget from route handlers
- Commit messages follow `type: description` format (e.g., `feat:`, `fix:`, `docs:`, `chore:`)
