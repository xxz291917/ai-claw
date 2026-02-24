# AI Hub

Company-level AI assistant platform. Multi-user, extensible, integrable.

See [docs/introduction.md](docs/introduction.md) for full details.

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
| `CHAT_PROVIDER` | `claude` or `generic` | No, defaults to `claude` |
| `ANTHROPIC_API_KEY` | Claude API key (when provider = `claude`) | One of these two |
| `CHAT_API_KEY` | API key (when provider = `generic`) | is required |
| `CHAT_MODEL` | Model name (generic provider) | Yes (generic) |
| `CHAT_API_BASE` | API base URL (generic provider) | Yes (generic) |
| `WORKSPACE_DIR` | AI workspace directory | Yes |
| `PORT` | Server port | No, defaults to `8080` |
| `SENTRY_AUTH_TOKEN` | Sentry API token | No |
| `GH_TOKEN` | GitHub token | No |
| `SKILLS_EXTRA_DIRS` | Extra skill directories (comma-separated) | No |

## Project Structure

```
src/
├── index.ts              # Entry point
├── server.ts             # Route registration, feature init
├── env.ts                # Env validation (Zod)
├── db.ts                 # SQLite client
├── core/                 # Event bus, audit log
├── chat/                 # Chat core (router, providers, system prompt, commands)
├── tools/                # Tool definitions (UnifiedToolDef)
├── skills/               # Built-in skills (Markdown)
├── memory/               # User memory (FTS5)
├── sessions/             # Session management
└── public/               # Frontend static files
```

## Tech Stack

Node.js 22 · TypeScript 5.9 · Hono · SQLite (better-sqlite3, WAL) · Claude Agent SDK · Vitest

## Docs

- [Introduction](docs/introduction.md) — Background, features, comparison, roadmap
- [Architecture](docs/architecture.md)
- [Problem & Solution](docs/Solution%20for%20Engineers%20cannot%20focus%20on%20high-value%20%20303c2345ab46807b8154ed52adfcebaa.md)
