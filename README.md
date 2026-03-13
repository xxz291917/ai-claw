# AI Claw

A self-hosted AI assistant you can deploy for your team. Multi-user auth, sandboxed tool execution, pluggable AI providers, multi-channel access (Web + Lark), scheduled tasks, and a fully extensible skill/tool system — all in a single lightweight Node.js service.

## Who is this for?

- **Teams** that want a shared AI assistant with per-user sessions, memory, and audit logging
- **Companies** deploying an internal ChatGPT/Claude alternative with tool access (bash, file I/O, web search, Sentry, GitHub, etc.)
- **Developers** building on top of a multi-provider AI engine — swap between Claude, DeepSeek, Kimi, or any OpenAI-compatible API without changing code

## Multi-User Support

AI Claw is designed for shared team deployment. Every user gets **isolated sessions, memory, and conversation history** — one service serves the whole team.

### How it works

```
                 ┌─────────────────────────────────────────────┐
                 │              AI Claw Server                  │
  Alice ──────►  │  ┌─────────┐  ┌────────┐  ┌─────────────┐  │
  (token A)      │  │ Session  │  │ Memory │  │ Conversation │  │
                 │  │ (Alice)  │  │(Alice) │  │   History    │  │
  Bob ────────►  │  ├─────────┤  ├────────┤  │  (per-user)  │  │
  (token B)      │  │ Session  │  │ Memory │  │              │  │
                 │  │  (Bob)   │  │ (Bob)  │  │              │  │
  Lark Group ─►  │  ├─────────┤  ├────────┤  │              │  │
  (@mention)     │  │ Session  │  │ Memory │  │              │  │
                 │  │ (group)  │  │(group) │  │              │  │
                 │  └─────────┘  └────────┘  └─────────────┘  │
                 └─────────────────────────────────────────────┘
```

**Setup** — one env var, no database migration:

```bash
# Add users as name:token pairs
CHAT_USERS=alice:sk-alice-secret,bob:sk-bob-secret

# Omit CHAT_USERS for anonymous single-user mode (great for personal use)
```

**What each user gets:**

| Feature | Isolation level |
|---------|----------------|
| **Authentication** | Bearer token per user, verified on every request |
| **Sessions** | Each user has independent sessions, keyed by `userId + channel` |
| **Conversation history** | Fully isolated — users never see each other's chats |
| **Memory** | Per-user FTS5 full-text search (CJK-aware). AI remembers preferences, facts, and context per user |
| **Concurrency** | Per-session locking — one user's slow request won't block another's |
| **Lark (飞书)** | P2P: each user identified by `lark:<openId>`. Group chats: shared identity via `lark-group:<chatId>` |

**Web UI login flow:**

1. User opens the Web UI → auth modal prompts for token
2. Token stored in `localStorage`, sent as `Authorization: Bearer <token>` on every request
3. Server resolves token → userId, all subsequent operations scoped to that user

## Highlights

| | |
|---|---|
| **Multi-provider** | Claude Agent SDK + any OpenAI-compatible API. Register extra providers via `PROVIDER_{NAME}_*` env vars — no code changes |
| **Multi-channel** | Web UI (SSE streaming) and Lark (飞书) bot — same conversation engine |
| **Tools** | Sandboxed bash, file read/write, web fetch/search, Sentry queries, Claude Code delegation, MCP servers |
| **Skills** | Markdown-based skill system with YAML frontmatter, eligibility checking, and on-demand loading |
| **Scheduled tasks** | Built-in cron engine (`at` / `every` / `cron`), SQLite persistence, backoff, max concurrency |
| **Security** | Workspace sandbox, command allowlist, sensitive file blocklist, env var stripping |

## Quick Start

```bash
npm install
cp .env.example .env    # configure API keys
npm run dev             # http://localhost:8080
```

## Commands

```bash
npm run dev          # Dev mode (tsx watch)
npm run build        # Compile to dist/
npm start            # Run compiled output
npm test             # Run tests
npm run test:watch   # Watch mode
```

## Deployment

### Docker (recommended)

```bash
docker build -t ai-claw .
docker run -d -p 3000:3000 --env-file .env \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/skills_extra:/app/skills_extra \
  ai-claw
```

Multi-stage build (node:22-slim), runs as non-root `aiclaw` user via `pm2-runtime`.

### PM2 (bare metal)

```bash
npm run build
pm2 start ecosystem.config.cjs
```

> **Note:** Claude CLI refuses to run as root. The PM2 config auto-drops privileges to `aiclaw` user. `exec_mode` is set to `"fork"` (not cluster) for ESM compatibility.

## Configuration

Copy `.env.example` for the full list. Key variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `CHAT_USERS` | Multi-user auth: `name:token` pairs, comma-separated |
| `CHAT_PROVIDER` | Active provider (`claude` / any registered name) |
| `PROVIDER_{NAME}_API_BASE` | Auto-register additional OpenAI-compatible providers |
| `PROVIDER_{NAME}_API_KEY` | API key for additional provider |
| `PROVIDER_{NAME}_MODEL` | Model for additional provider |
| `WORKSPACE_DIR` | Sandbox directory for AI file operations |
| `BASH_EXEC_ALLOWED_COMMANDS` | Command allowlist for bash tool |
| `SKILLS_EXTRA_DIRS` | Extra skill directories (comma-separated) |
| `LARK_ENABLED` | Enable Lark (飞书) bot channel |
| `PORT` | Server port (default: 8080) |

## Architecture

```
User ─┬─ Web UI (SSE) ──► WebChannel ─┐
      │                                ├─► handleConversation() ─► Provider ─► AI
      └─ Lark Bot ──────► LarkChannel ─┘         │
                                            ┌─────┴─────┐
                                          Tools    Skills/Memory
```

### Project Structure

```
src/
├── server.ts             # App assembly
├── env.ts                # Env validation (Zod)
├── db.ts                 # SQLite (WAL mode)
├── core/                 # Event bus, audit log
├── channels/             # Channel abstraction (Web, Lark)
├── chat/                 # Providers, registry, commands, compaction
├── cron/                 # Scheduled task engine
├── subagent/             # Background task manager
├── tools/                # Tool definitions (UnifiedToolDef)
├── skills/               # Built-in skills (Markdown + YAML)
├── memory/               # Per-user FTS5 memory
├── sessions/             # Session management
└── public/               # Web frontend
```

## Security

- **Workspace isolation** — AI file operations sandboxed to `WORKSPACE_DIR`
- **Sensitive file blocklist** — `.env*`, `.pem`, `.key`, `credentials.json`, `id_rsa`, etc.
- **Bash command allowlist** — only whitelisted commands; shell metacharacters blocked
- **Env var stripping** — child processes have `KEY`/`SECRET`/`TOKEN`/`PASSWORD` vars removed

## Extending

### Add a provider

Set env vars — no code needed:

```bash
PROVIDER_DEEPSEEK_API_BASE=https://api.deepseek.com/v1
PROVIDER_DEEPSEEK_API_KEY=sk-xxx
PROVIDER_DEEPSEEK_MODEL=deepseek-chat
```

### Add a skill

Drop a Markdown file in `src/skills/builtins/` or a `skills_extra/` directory:

```yaml
---
name: my-skill
description: What this skill does
tags: [research]
allowed-tools: [web_search, web_fetch]
---

Your skill instructions here...
```

### Add an MCP server

Create `mcp-servers.json` (see `mcp-servers.example.json`):

```json
{
  "notion": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@notionhq/notion-mcp-server"],
    "env": { "OPENAPI_MCP_HEADERS": "..." }
  }
}
```

## Tech Stack

Node.js 22 · TypeScript 5.9 · Hono · SQLite (better-sqlite3, WAL) · Claude Agent SDK · Vitest
