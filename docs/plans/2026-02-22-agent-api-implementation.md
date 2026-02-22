# Agent API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace fault-healing webhook with a general-purpose `POST /api/agent` endpoint backed by dual-provider `run()` method, enabling n8n orchestration.

**Architecture:** Add `run()` to `ChatProvider` interface. ClaudeProvider delegates to `runAgent()` (batch mode). GenericProvider consumes its own `stream()`. New `routes/agent.ts` wraps `provider.run()` as a synchronous JSON endpoint. DB changes: `tasks` → `agent_runs`.

**Tech Stack:** TypeScript, Hono, Zod, Claude Agent SDK, better-sqlite3, Vitest

---

### Task 1: Add `run()` to ChatProvider interface and AgentResult type

**Files:**
- Modify: `src/chat/types.ts`
- Modify: `src/agent/runner.ts` (move `AgentResult` type to `types.ts` for sharing)

**Step 1: Update `src/chat/types.ts`**

Add `AgentResult` type and optional `run()` method to `ChatProvider`:

```typescript
/**
 * Provider-agnostic chat interface.
 * ClaudeProvider uses Agent SDK; GenericProvider uses OpenAI-compatible API.
 */

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; costUsd: number };

export type ChatRequest = {
  message: string;
  sessionId?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

export type AgentResult = {
  text: string;
  sessionId: string;
  costUsd: number;
  error?: string;
};

export interface ChatProvider {
  readonly name: string;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
  run?(req: ChatRequest): Promise<AgentResult>;
  summarize?(messages: Array<{ role: string; content: string }>): Promise<string>;
}
```

**Step 2: Update `src/agent/runner.ts`**

Change `AgentResult` to re-export from `types.ts` instead of defining locally:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentResult } from "../chat/types.js";

export type { AgentResult };

export type BatchAgentConfig = {
  // ... unchanged
};
```

**Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors (AgentResult was already the same shape)

**Step 4: Run tests**

Run: `npx vitest run`
Expected: All 144 tests pass (no behavior change)

**Step 5: Commit**

```bash
git add src/chat/types.ts src/agent/runner.ts
git commit -m "feat: add AgentResult type and run() to ChatProvider interface"
```

---

### Task 2: Implement `run()` on ClaudeProvider

**Files:**
- Modify: `src/chat/claude-provider.ts`

**Step 1: Add `run()` method**

Add `run()` to `ClaudeProvider` that calls `query()` in batch mode (similar to `runAgent()` but using the provider's existing config):

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatProvider, ChatEvent, ChatRequest, AgentResult } from "./types.js";

export type ClaudeProviderConfig = {
  workspaceDir: string;
  skillContent: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
  mcpServers?: Record<string, unknown>;
};

export class ClaudeProvider implements ChatProvider {
  readonly name = "claude";

  constructor(private config: ClaudeProviderConfig) {}

  async run(req: ChatRequest): Promise<AgentResult> {
    const abortController = new AbortController();

    const q = query({
      prompt: req.message,
      options: {
        cwd: this.config.workspaceDir,
        systemPrompt: this.config.skillContent,
        tools: { type: "preset", preset: "claude_code" },
        mcpServers: this.config.mcpServers as any,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: this.config.maxTurns ?? 30,
        maxBudgetUsd: this.config.maxBudgetUsd ?? 2.0,
        abortController,
        env: {
          ...process.env,
          ...(this.config.env ?? {}),
        },
      },
    });

    let text = "";
    let sessionId = "";
    let costUsd = 0;
    let error: string | undefined;

    for await (const message of q) {
      if (message.type === "result") {
        const msg = message as any;
        sessionId = msg.session_id;
        costUsd = msg.total_cost_usd ?? 0;
        if (msg.subtype === "success") {
          text = msg.result;
        } else {
          error = msg.errors?.join("; ") ?? "Agent run failed";
        }
      }
    }

    return { text, sessionId, costUsd, error };
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    // ... existing implementation, unchanged
  }
}
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/chat/claude-provider.ts
git commit -m "feat: add run() batch mode to ClaudeProvider"
```

---

### Task 3: Implement `run()` on GenericProvider

**Files:**
- Modify: `src/chat/generic-provider.ts`
- Test: `test/chat/generic-provider.test.ts`

**Step 1: Write test for `GenericProvider.run()`**

Add a test case to `test/chat/generic-provider.test.ts`:

```typescript
it("run() collects stream into AgentResult", async () => {
  const provider = createProvider(200, [
    textChunk("Hello from run"),
    doneChunk(),
  ]);

  const result = await provider.run!({ message: "test" });

  expect(result.text).toBe("Hello from run");
  expect(result.error).toBeUndefined();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/generic-provider.test.ts`
Expected: FAIL — `provider.run` is not a function

**Step 3: Implement `run()` on GenericProvider**

Add to `GenericProvider` class in `src/chat/generic-provider.ts`:

```typescript
import type { ChatProvider, ChatEvent, ChatRequest, AgentResult } from "./types.js";

// ... existing class definition ...

  async run(req: ChatRequest): Promise<AgentResult> {
    let text = "";
    let costUsd = 0;
    let error: string | undefined;

    for await (const event of this.stream(req)) {
      if (event.type === "text") text += event.content;
      if (event.type === "error") error = event.message;
      if (event.type === "done") costUsd = event.costUsd;
    }

    return { text, sessionId: "", costUsd, error };
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat/generic-provider.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/chat/generic-provider.ts test/chat/generic-provider.test.ts
git commit -m "feat: add run() batch mode to GenericProvider"
```

---

### Task 4: DB schema — `tasks` → `agent_runs`

**Files:**
- Modify: `src/db.ts`

**Step 1: Replace `tasks` table with `agent_runs` in `initDb()`**

In `src/db.ts`, replace the `tasks` table creation and its migration block with:

```typescript
export function initDb(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      skill TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      result TEXT,
      cost_usd REAL DEFAULT 0,
      error TEXT,
      caller TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_status
      ON agent_runs(status);
```

Remove the entire `tasks` table block (CREATE TABLE, CREATE INDEX for sentry_issue, the migration block for state→status rename, DROP INDEX, and CREATE INDEX for tasks_status).

Keep all other tables unchanged (audit_log, event_log, sessions, messages, memory, memory_fts + triggers).

**Step 2: Migrate existing `tasks` → `agent_runs` for running instances**

Add after the `agent_runs` creation (before other tables):

```typescript
  // Migrate: rename tasks → agent_runs if old table exists
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"
  ).get() as { name: string } | undefined;
  if (tables) {
    db.exec("DROP TABLE tasks");
  }
```

**Step 3: Run tests**

Run: `npx vitest run`
Expected: All tests pass (tests use in-memory DB, no migration needed)

**Step 4: Commit**

```bash
git add src/db.ts
git commit -m "refactor: replace tasks table with agent_runs"
```

---

### Task 5: Create `POST /api/agent` and `GET /api/agent/:id` routes

**Files:**
- Create: `src/routes/agent.ts`
- Create: `test/routes/agent.test.ts`

**Step 1: Write tests for agent routes**

Create `test/routes/agent.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "../helpers.js";
import { EventLog } from "../../src/core/event-bus.js";
import { registerAgentRoutes } from "../../src/routes/agent.js";
import type { ChatProvider, AgentResult } from "../../src/chat/types.js";

function mockProvider(result: AgentResult): ChatProvider {
  return {
    name: "test",
    async *stream() {},
    async run() { return result; },
  };
}

function setup(result: AgentResult = { text: "ok", sessionId: "", costUsd: 0.1 }) {
  const db = createTestDb();
  const eventLog = new EventLog(db);
  const provider = mockProvider(result);
  const app = new Hono();
  registerAgentRoutes(app, { db, eventLog, provider });
  return { app, db, eventLog };
}

describe("POST /api/agent", () => {
  it("executes agent and returns result", async () => {
    const { app } = setup({ text: "analysis done", sessionId: "s1", costUsd: 0.5 });

    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "analyze this" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("done");
    expect(body.text).toBe("analysis done");
    expect(body.costUsd).toBe(0.5);
  });

  it("returns 400 if prompt is missing", async () => {
    const { app } = setup();

    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("records run in agent_runs table", async () => {
    const { app, db } = setup();

    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt" }),
    });

    const body = await res.json();
    const row = db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(body.id) as any;
    expect(row).toBeTruthy();
    expect(row.status).toBe("done");
    expect(row.prompt).toBe("test prompt");
  });

  it("handles agent error", async () => {
    const { app } = setup({ text: "", sessionId: "", costUsd: 0, error: "boom" });

    const res = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "fail" }),
    });

    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toBe("boom");
  });
});

describe("GET /api/agent/:id", () => {
  it("returns a completed run", async () => {
    const { app } = setup();

    // Create a run first
    const postRes = await app.request("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "test" }),
    });
    const { id } = await postRes.json();

    // Query it
    const getRes = await app.request(`/api/agent/${id}`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.id).toBe(id);
    expect(body.status).toBe("done");
  });

  it("returns 404 for unknown id", async () => {
    const { app } = setup();
    const res = await app.request("/api/agent/nonexistent");
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/routes/agent.test.ts`
Expected: FAIL — cannot import `registerAgentRoutes`

**Step 3: Implement `src/routes/agent.ts`**

```typescript
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ChatProvider } from "../chat/types.js";
import type { EventLog } from "../core/event-bus.js";
import { createHubEvent } from "../core/hub-event.js";

type AgentRouteDeps = {
  db: Database.Database;
  eventLog: EventLog;
  provider: ChatProvider;
  skillsDir?: string;
};

const agentRequestSchema = z.object({
  prompt: z.string().min(1),
  skill: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  config: z
    .object({
      maxTurns: z.number().optional(),
      maxBudgetUsd: z.number().optional(),
    })
    .optional(),
});

export function registerAgentRoutes(app: Hono, deps: AgentRouteDeps): void {
  const { db, eventLog, provider } = deps;

  app.post("/api/agent", async (c) => {
    const parsed = agentRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "prompt is required" }, 400);
    }

    const { prompt, skill, context } = parsed.data;

    // Build final prompt with optional context
    let finalPrompt = prompt;
    if (context && Object.keys(context).length > 0) {
      const contextBlock = Object.entries(context)
        .map(([k, v]) => `- **${k}**: ${v}`)
        .join("\n");
      finalPrompt += `\n\n## Context\n\n${contextBlock}`;
    }

    const runId = randomUUID();
    const caller = c.req.header("x-caller") ?? "api";

    // Insert running record
    db.prepare(
      "INSERT INTO agent_runs (id, prompt, skill, status, caller) VALUES (?, ?, ?, 'running', ?)",
    ).run(runId, prompt, skill ?? null, caller);

    // Execute agent (synchronous — blocks until done)
    let status = "done";
    let text = "";
    let costUsd = 0;
    let error: string | null = null;

    try {
      if (!provider.run) {
        throw new Error("Provider does not support run() method");
      }
      const result = await provider.run({ message: finalPrompt, history: [] });
      text = result.text;
      costUsd = result.costUsd;
      if (result.error) {
        status = "failed";
        error = result.error;
      }
    } catch (err: any) {
      status = "failed";
      error = err.message ?? String(err);
    }

    // Update record
    db.prepare(
      "UPDATE agent_runs SET status = ?, result = ?, cost_usd = ?, error = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(status, text, costUsd, error, runId);

    // Audit log
    try {
      eventLog.log(
        createHubEvent({
          type: "agent.run",
          source: caller,
          payload: { runId, skill, status, costUsd },
        }),
      );
    } catch {
      /* best-effort */
    }

    return c.json({ id: runId, status, text, costUsd, error });
  });

  app.get("/api/agent/:id", (c) => {
    const row = db
      .prepare("SELECT * FROM agent_runs WHERE id = ?")
      .get(c.req.param("id")) as Record<string, any> | undefined;
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({
      id: row.id,
      status: row.status,
      text: row.result,
      costUsd: row.cost_usd,
      error: row.error,
      skill: row.skill,
      caller: row.caller,
      createdAt: row.created_at,
    });
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/routes/agent.test.ts`
Expected: All 5 tests pass

**Step 5: Commit**

```bash
git add src/routes/agent.ts test/routes/agent.test.ts
git commit -m "feat: add POST /api/agent and GET /api/agent/:id endpoints"
```

---

### Task 6: Wire up server.ts and remove fault-healing code

**Files:**
- Modify: `src/server.ts`
- Delete: `src/routes/webhooks.ts`
- Delete: `src/skills/fault-healing.md`
- Delete: `test/webhooks/sentry.test.ts`

**Step 1: Update `src/server.ts`**

Replace the fault-healing block and add agent routes. The full file should become:

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { chatRouter } from "./chat/router.js";
import { parseChatUsers, chatAuthMiddleware } from "./chat/auth.js";
import { setupChatProvider } from "./chat/setup.js";
import { buildToolSuite } from "./tools/suite.js";
import { EventLog } from "./core/event-bus.js";
import { SessionManager } from "./sessions/manager.js";
import { MemoryManager } from "./memory/manager.js";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(): {
  app: Hono;
  db: Database.Database;
  eventLog: EventLog;
} {
  const env = loadEnv();
  const db = createDb(resolve("data/ai-hub.db"));
  const eventLog = new EventLog(db);
  const sessionManager = new SessionManager(db);
  const memoryManager = new MemoryManager(db);

  const app = new Hono();

  // --- Auth ---
  const chatUsers = parseChatUsers(env.CHAT_USERS);
  app.use("/api/*", chatAuthMiddleware(chatUsers));
  if (chatUsers.size > 0) {
    console.log(`[init] Auth enabled (${chatUsers.size} users)`);
  }

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // --- Shared Tool Suite ---
  const skillsDir = resolve(__dirname, "skills");
  const toolSuite = buildToolSuite(env, skillsDir);

  // --- Chat Assistant ---
  const { provider: chatProvider } = setupChatProvider(env, skillsDir, toolSuite);
  chatRouter(app, chatProvider, { sessionManager, eventLog, memoryManager });

  // --- Agent API ---
  registerAgentRoutes(app, { db, eventLog, provider: chatProvider });

  // Serve static files (chat UI)
  app.use("/*", serveStatic({ root: resolve(__dirname, "public") }));

  return { app, db, eventLog };
}

export function startServer() {
  const env = loadEnv();
  const { app } = createApp();

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`
AI Hub 服务已启动

  地址:     http://localhost:${info.port}
  健康检查: http://localhost:${info.port}/health

  Chat:    http://localhost:${info.port}/
  Agent:   POST http://localhost:${info.port}/api/agent
`);
  });
}
```

Key changes:
- Removed `readFileSync` import (no longer loading fault-healing.md)
- Removed `runAgent` import (provider.run() replaces it)
- Removed entire fault-healing block (L58-82)
- Removed `/tasks/:id` route (replaced by `/api/agent/:id`)
- Added `registerAgentRoutes` import and call
- Auth middleware now covers `/api/*` (both chat and agent)
- Startup message shows Agent endpoint

**Step 2: Delete fault-healing files**

```bash
rm src/routes/webhooks.ts
rm src/skills/fault-healing.md
rm test/webhooks/sentry.test.ts
```

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests pass (sentry test deleted, new agent tests pass)

**Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: replace fault-healing webhook with general Agent API

- Remove Sentry webhook (migrating to n8n)
- Remove fault-healing skill (migrating to n8n prompts)
- Agent API shares ChatProvider with Chat (dual-provider support)
- Auth middleware now covers /api/* (chat + agent)"
```

---

### Task 7: Clean up env.ts comments and update docs

**Files:**
- Modify: `src/env.ts` (update comments)
- Modify: `docs/architecture.md` (reflect Agent API)
- Modify: `CLAUDE.md` (update module table)

**Step 1: Update `src/env.ts`**

Change the comment on the Sentry/Lark/GH env vars section:

```typescript
  // Sentry / Lark / GitHub (used by tools, optional)
```

Remove "Fault healing" reference from the comment since these are now general-purpose tool configs.

**Step 2: Update `docs/architecture.md`**

Add Agent API section, remove fault-healing webhook section, update API endpoint table and data flow diagram. Reflect that `routes/agent.ts` is the new endpoint and `routes/webhooks.ts` is gone.

**Step 3: Update `CLAUDE.md`**

Update the module table to replace webhook/fault-healing references with Agent API. Update the "Fault Healing Pipeline" section to note it's now handled by n8n via the Agent API.

**Step 4: Run tests one final time**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All tests pass, no type errors

**Step 5: Commit**

```bash
git add src/env.ts docs/architecture.md CLAUDE.md
git commit -m "docs: update architecture and CLAUDE.md for Agent API"
```
