---
name: session-logs
description: "Search and analyze AI Hub session logs and conversation history. Use when user asks about prior conversations or session data."
tags: [debugging, sessions, analytics]
allowed-tools: Read, Grep, Bash
---

# Session Logs

Search and analyze AI Hub conversation history stored in the SQLite database.

## Trigger

Use this skill when the user asks about prior chats, historical context, or session analytics.

## Data Location

AI Hub stores sessions and messages in the SQLite database at `data/ai-hub.db`.

### Tables

- **sessions** — Session metadata (id, userId, channel, provider, status, timestamps)
- **messages** — Conversation messages (session_id, role, content, timestamp)
- **events** — Event log (type, source, payload, timestamp)

## Common Queries

### List recent sessions

```bash
sqlite3 data/ai-hub.db "SELECT id, channel, provider, status, created_at FROM sessions ORDER BY created_at DESC LIMIT 20;"
```

### Get messages from a session

```bash
sqlite3 data/ai-hub.db "SELECT role, content, created_at FROM messages WHERE session_id = '<SESSION_ID>' ORDER BY created_at;"
```

### Search messages for keyword

```bash
sqlite3 data/ai-hub.db "SELECT m.session_id, m.role, m.content FROM messages m WHERE m.content LIKE '%keyword%' ORDER BY m.created_at DESC LIMIT 20;"
```

### Count messages per session

```bash
sqlite3 data/ai-hub.db "SELECT session_id, COUNT(*) as msg_count FROM messages GROUP BY session_id ORDER BY msg_count DESC LIMIT 20;"
```

### Session activity by day

```bash
sqlite3 data/ai-hub.db "SELECT DATE(created_at) as day, COUNT(*) as sessions FROM sessions GROUP BY day ORDER BY day DESC;"
```

### Event log analysis

```bash
sqlite3 data/ai-hub.db "SELECT type, source, created_at FROM events ORDER BY created_at DESC LIMIT 50;"
```

## Tips

- Use `.mode column` and `.headers on` for readable output
- For JSON output: `.mode json`
- Sessions are append-only; messages are never deleted (except via /reset command)
- The `status` field tracks session lifecycle: open -> closed
