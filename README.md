# AI Claw

A lightweight AI assistant engine inspired by OpenClaw — built for company-internal deployment with multi-user auth, sandboxed tool execution, multi-channel access (Web & Lark), scheduled tasks, and a fully extensible skill/tool system.

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

### PM2 (bare metal)

```bash
npm run build
pm2 start ecosystem.config.cjs
```

> **Root server note:** Claude CLI (Agent SDK) refuses to run as root. The
> `ecosystem.config.cjs` auto-detects root and sets `uid/gid` to drop
> privileges to `aiclaw` user. `exec_mode` is explicitly set to `"fork"` —
> PM2 silently defaults to `"cluster"` when `uid/gid` is present, which
> breaks ESM module resolution. Ensure the `aiclaw` user exists on the server
> and has read access to the project directory.
>
> On Rocky Linux 8, `gcc-toolset-12` is required to compile `better-sqlite3`:
> ```bash
> source /opt/rh/gcc-toolset-12/enable && npm ci
> ```

### Docker

```bash
docker build -t ai-claw .
docker run -d -p 3000:3000 --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/skills_extra:/app/skills_extra \
  ai-claw
```

The Docker image uses a multi-stage build (node:22-slim) with `pm2-runtime` in foreground mode. A non-root user `aiclaw` (uid 1001) is created for Claude provider compatibility.

## Environment Variables

Copy `.env.example` and configure as needed:

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Claude API key (when provider = `claude`) | One of these |
| `CHAT_API_KEY` | API key (when provider = `generic`) | is required |
| `CHAT_PROVIDER` | Provider name (default: `claude`, or any registered name) | No |
| `CHAT_MODEL` | Model name (generic provider) | Yes (generic) |
| `CHAT_API_BASE` | API base URL (generic provider) | Yes (generic) |
| `PROVIDER_{NAME}_API_BASE` | Auto-register additional providers | No |
| `PROVIDER_{NAME}_API_KEY` | API key for additional provider | No |
| `PROVIDER_{NAME}_MODEL` | Model for additional provider | No |
| `WORKSPACE_DIR` | AI workspace directory | Yes |
| `PORT` | Server port | No, defaults to `8080` |
| `SENTRY_AUTH_TOKEN` | Sentry API token (enables `sentry_query` tool) | No |
| `GH_TOKEN` | GitHub token (for `gh` CLI) | No |
| `SKILLS_EXTRA_DIRS` | Extra skill directories (comma-separated) | No |
| `LARK_APP_ID` | Lark (飞书) app ID | No |
| `LARK_APP_SECRET` | Lark app secret | No |
| `LARK_VERIFICATION_TOKEN` | Lark event verification token | No |
| `NOTION_API_KEY` | Notion API key (enables notion skill) | No |

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
├── cron/                 # Scheduled task engine (store, service, commands)
├── subagent/             # Background task manager
├── tools/                # Tool definitions (UnifiedToolDef)
├── skills/               # Built-in skills (Markdown + YAML frontmatter)
├── memory/               # User memory (FTS5)
├── sessions/             # Session management
├── lark/                 # Lark SDK client
└── public/               # Frontend static files
```

## Security

- **Workspace isolation**: `WORKSPACE_DIR` defaults to `data/workspace` — AI file operations (`file_read`/`file_write`) are sandboxed to this directory, keeping `.env` and project source out of reach
- **Sensitive file blocklist**: `safePath()` blocks access to `.env*`, `.pem`, `.key`, `credentials.json`, `.netrc`, `.npmrc`, `id_rsa`, `id_ed25519`, etc.
- **Bash command allowlist**: `BASH_EXEC_ALLOWED_COMMANDS` restricts which commands the AI can execute (pipes allowed, each segment checked individually). Shell metacharacters (`;`, `&`, `` ` ``, `$`, `()`, `{}`, `<>`) are blocked
- **Sensitive file guard in bash**: Commands referencing sensitive files (e.g., `cat .env`) are rejected
- **Environment sanitization**: Child processes spawned by `bash_exec` have env vars containing `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `CREDENTIAL` stripped

## Features

- **Multi-provider AI**: Claude Agent SDK, any OpenAI-compatible API (DeepSeek, Kimi, etc.) via registry pattern
- **Multi-channel**: Web (SSE streaming) and Lark (飞书) bot
- **Skills system**: Markdown-based skills with YAML frontmatter, eligibility checking, and on-demand loading. Supports flat files and ClawHub directory format
- **Scheduled tasks**: Cron engine with `at`/`every`/`cron` schedule types, SQLite persistence, exponential backoff
- **Tools**: Sandboxed bash, file read/write, web fetch/search, Sentry queries, Claude Code delegation, MCP server integration
- **Memory**: Per-user FTS5 full-text search with CJK support, auto-extraction from conversations
- **Session management**: Persistent sessions with history compaction and token budget tracking

## Tech Stack

Node.js 22 · TypeScript 5.9 · Hono · SQLite (better-sqlite3, WAL) · Claude Agent SDK · Lark SDK · Vitest

## Docs

- [Architecture](docs/architecture.md)
