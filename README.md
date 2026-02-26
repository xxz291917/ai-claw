# AI Claw

An lightweight AI assistant engine inspired by OpenClaw — built for company-internal deployment with multi-user auth, sandboxed tool execution, multi-channel access (Web & Lark), and a fully extensible skill/tool system.

## Quick Start

```bash
npm install

cp .env.example .env
# Edit .env — configure API keys and model settings

npm run dev

# Visit http://localhost:8080
```

## Commands

```bash
npm run dev          # Dev mode (tsx watch)
npm run build        # Compile to dist/
npm start            # Run compiled output
npm test             # Run tests
npm run test:watch   # Watch mode
```

## Production

```bash
npm run build
pm2 start ecosystem.config.cjs
```

## Environment Variables

Copy `.env.example` and configure as needed:

| Variable | Description | Required |
|----------|-------------|----------|
| `CHAT_PROVIDER` | Provider name (default: `claude`, or any registered name) | No |
| `ANTHROPIC_API_KEY` | Claude API key (when provider = `claude`) | One of these |
| `CHAT_API_KEY` | API key (when provider = `generic`) | is required |
| `CHAT_MODEL` | Model name (generic provider) | Yes (generic) |
| `CHAT_API_BASE` | API base URL (generic provider) | Yes (generic) |
| `PROVIDER_{NAME}_API_BASE` | Auto-register additional providers | No |
| `PROVIDER_{NAME}_API_KEY` | API key for additional provider | No |
| `PROVIDER_{NAME}_MODEL` | Model for additional provider | No |
| `WORKSPACE_DIR` | AI workspace directory | Yes |
| `PORT` | Server port | No, defaults to `8080` |
| `SENTRY_AUTH_TOKEN` | Sentry API token | No |
| `GH_TOKEN` | GitHub token | No |
| `SKILLS_EXTRA_DIRS` | Extra skill directories (comma-separated) | No |
| `LARK_APP_ID` | Lark (飞书) app ID | No |
| `LARK_APP_SECRET` | Lark app secret | No |
| `LARK_VERIFICATION_TOKEN` | Lark event verification token | No |

## Project Structure

```
src/
├── index.ts              # Entry point
├── server.ts             # App assembly, init flow
├── env.ts                # Env validation (Zod)
├── db.ts                 # SQLite client
├── core/                 # Event bus, audit log
├── channels/             # Channel abstraction (Web, Lark)
├── chat/                 # Chat core (providers, registry, commands, compaction)
├── subagent/             # Background task manager
├── tools/                # Tool definitions (UnifiedToolDef)
├── skills/               # Built-in skills (Markdown)
├── memory/               # User memory (FTS5)
├── sessions/             # Session management
├── lark/                 # Lark SDK client
└── public/               # Frontend static files
```

## Tech Stack

Node.js 22 · TypeScript 5.9 · Hono · SQLite (better-sqlite3, WAL) · Claude Agent SDK · Lark SDK · Vitest

## Docs

- [Architecture](docs/architecture.md)
