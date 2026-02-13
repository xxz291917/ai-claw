# AI Hub Phase 1: 故障自愈 MVP 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 搭建 AI Hub 服务，接收 Sentry 报警后自动分析、修复代码、创建 PR，全程通过飞书卡片与工程师交互。

**Architecture:** Hono Web 服务接收 Sentry webhook，创建任务写入 SQLite，通过状态机推进任务阶段。每个阶段调用 Claude Agent SDK 执行 AI 分析/修复，通过飞书卡片通知工程师并接收审批回调。外层编排（状态机 + 审批）由我们代码控制，内层编排（AI 思考 + 工具调用）由 Claude Agent SDK 自动完成。

**Tech Stack:** Node.js 22+ / TypeScript ESM / Hono / SQLite (better-sqlite3) / @anthropic-ai/claude-agent-sdk / @larksuiteoapi/node-sdk / Zod / Vitest

**Design Doc:** [ai-hub-interaction-design.md](./2026-02-12-ai-hub-interaction-design.md)

---

## Project structure

```
ai-hub/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
├── src/
│   ├── index.ts                  # Entry: start server
│   ├── env.ts                    # Env config (zod validated)
│   ├── db.ts                     # SQLite client + schema init
│   ├── server.ts                 # Hono app factory
│   ├── tasks/
│   │   ├── types.ts              # Task states, events, transitions
│   │   └── store.ts              # Task CRUD + state transitions
│   ├── webhooks/
│   │   └── sentry.ts             # POST /webhooks/sentry
│   ├── agent/
│   │   ├── runner.ts             # Claude Agent SDK wrapper
│   │   └── tools/
│   │       └── sentry-query.ts   # sentry_query MCP tool
│   ├── lark/
│   │   ├── notify.ts             # Send Lark interactive cards
│   │   └── callback.ts           # POST /callbacks/lark
│   ├── workflows/
│   │   └── fault-healing.ts      # Orchestrate full flow
│   └── skills/
│       └── fault-healing.md      # AI skill: fault healing guide
└── test/
    ├── helpers.ts                # Shared test utilities
    ├── tasks/
    │   └── store.test.ts
    ├── webhooks/
    │   └── sentry.test.ts
    ├── agent/
    │   └── runner.test.ts
    ├── lark/
    │   └── notify.test.ts
    └── workflows/
        └── fault-healing.test.ts
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `ai-hub/package.json`
- Create: `ai-hub/tsconfig.json`
- Create: `ai-hub/vitest.config.ts`
- Create: `ai-hub/.env.example`
- Create: `ai-hub/.gitignore`

**Step 1: Create project directory**

```bash
mkdir -p ~/Documents/code/ai-hub
cd ~/Documents/code/ai-hub
```

**Step 2: Initialize project**

```bash
npm init -y
```

**Step 3: Install dependencies**

```bash
npm install hono @hono/node-server better-sqlite3 zod @anthropic-ai/claude-agent-sdk @larksuiteoapi/node-sdk
npm install -D typescript @types/node @types/better-sqlite3 tsx vitest
```

**Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**Step 5: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
```

**Step 6: Create .env.example**

```bash
# Claude API
ANTHROPIC_API_KEY=sk-ant-xxx

# Sentry
SENTRY_AUTH_TOKEN=sntrys_xxx
SENTRY_ORG=your-org
SENTRY_PROJECT=your-project

# Lark
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_NOTIFY_CHAT_ID=oc_xxx

# GitHub (Claude Code uses gh CLI, needs GH_TOKEN in env)
GH_TOKEN=ghp_xxx
GITHUB_REPO=owner/repo

# Server
PORT=8080

# Workspace (target repo for AI to work on)
WORKSPACE_DIR=/path/to/target/repo
```

**Step 7: Create .gitignore**

```
node_modules/
dist/
.env
*.db
```

**Step 8: Update package.json scripts**

Edit `package.json` to add:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 9: Initialize git + commit**

```bash
git init
git add -A
git commit -m "chore: project scaffolding"
```

---

### Task 2: Environment config + Database

**Files:**
- Create: `src/env.ts`
- Create: `src/db.ts`
- Test: `test/helpers.ts`

**Step 1: Write test helper (shared in-memory DB factory)**

Create `test/helpers.ts`:

```typescript
import Database from "better-sqlite3";
import { initDb } from "../src/db.js";

export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  initDb(db);
  return db;
}
```

**Step 2: Write src/env.ts**

```typescript
import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  SENTRY_AUTH_TOKEN: z.string().min(1),
  SENTRY_ORG: z.string().min(1),
  SENTRY_PROJECT: z.string().min(1),
  LARK_APP_ID: z.string().min(1),
  LARK_APP_SECRET: z.string().min(1),
  LARK_NOTIFY_CHAT_ID: z.string().min(1),
  GH_TOKEN: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  PORT: z.coerce.number().default(8080),
  WORKSPACE_DIR: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;
  _env = envSchema.parse(process.env);
  return _env;
}

/** For testing: inject env without parsing process.env */
export function setEnv(env: Env): void {
  _env = env;
}
```

**Step 3: Write src/db.ts**

```typescript
import Database from "better-sqlite3";

export function initDb(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'fault_healing',
      state TEXT NOT NULL DEFAULT 'pending',
      sentry_issue_id TEXT,
      sentry_event_id TEXT,
      title TEXT NOT NULL,
      severity TEXT,
      analysis TEXT,
      pr_url TEXT,
      lark_message_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_sentry_issue
      ON tasks(sentry_issue_id);

    CREATE INDEX IF NOT EXISTS idx_tasks_state
      ON tasks(state);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function createDb(path: string): Database.Database {
  const db = new Database(path);
  initDb(db);
  return db;
}
```

**Step 4: Verify DB initialization works**

```bash
npx vitest run
```

Expected: no tests yet, passes with 0 tests.

**Step 5: Commit**

```bash
git add src/env.ts src/db.ts test/helpers.ts
git commit -m "feat: add env config and database schema"
```

---

### Task 3: Task state management

**Files:**
- Create: `src/tasks/types.ts`
- Create: `src/tasks/store.ts`
- Test: `test/tasks/store.test.ts`

**Step 1: Write the failing test**

Create `test/tasks/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { TaskStore } from "../../src/tasks/store.js";
import type { TaskState } from "../../src/tasks/types.js";
import type Database from "better-sqlite3";

describe("TaskStore", () => {
  let db: Database.Database;
  let store: TaskStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  it("creates a task with pending state", () => {
    const task = store.create({
      sentryIssueId: "ISSUE-1",
      sentryEventId: "evt-abc",
      title: "TypeError in handler.ts",
      severity: "P1",
    });

    expect(task.id).toBeDefined();
    expect(task.state).toBe("pending");
    expect(task.sentryIssueId).toBe("ISSUE-1");
  });

  it("deduplicates by sentry_issue_id", () => {
    store.create({ sentryIssueId: "ISSUE-1", sentryEventId: "evt-1", title: "Error", severity: "P1" });
    const dup = store.findByIssueId("ISSUE-1");
    expect(dup).not.toBeNull();
  });

  it("transitions state: pending → analyzing", () => {
    const task = store.create({ sentryIssueId: "ISSUE-2", sentryEventId: "evt-2", title: "Error", severity: "P2" });
    const updated = store.transition(task.id, "analyze");
    expect(updated.state).toBe("analyzing");
  });

  it("rejects invalid transition: pending → fixing", () => {
    const task = store.create({ sentryIssueId: "ISSUE-3", sentryEventId: "evt-3", title: "Error", severity: "P3" });
    expect(() => store.transition(task.id, "fix")).toThrow(/invalid transition/i);
  });

  it("stores analysis result", () => {
    const task = store.create({ sentryIssueId: "ISSUE-4", sentryEventId: "evt-4", title: "Error", severity: "P1" });
    store.transition(task.id, "analyze");
    store.updateAnalysis(task.id, "Root cause: null ref in handler.ts:42");
    const found = store.getById(task.id);
    expect(found?.analysis).toContain("null ref");
  });

  it("stores PR URL", () => {
    const task = store.create({ sentryIssueId: "ISSUE-5", sentryEventId: "evt-5", title: "Error", severity: "P1" });
    store.transition(task.id, "analyze");
    store.transition(task.id, "report");
    store.transition(task.id, "fix");
    store.updatePrUrl(task.id, "https://github.com/org/repo/pull/42");
    const found = store.getById(task.id);
    expect(found?.prUrl).toContain("/pull/42");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run test/tasks/store.test.ts
```

Expected: FAIL — modules not found.

**Step 3: Write src/tasks/types.ts**

```typescript
/**
 * Fault-healing task states:
 *
 *   pending → analyzing → reported → fixing → pr_ready → merged → done
 *                ↓            ↓         ↓         ↓
 *              failed      ignored    failed    rejected
 */
export type TaskState =
  | "pending"
  | "analyzing"
  | "reported"
  | "fixing"
  | "pr_ready"
  | "merged"
  | "done"
  | "failed"
  | "ignored"
  | "rejected";

export type TaskEvent =
  | "analyze"    // pending → analyzing
  | "report"     // analyzing → reported
  | "fix"        // reported → fixing
  | "pr_created" // fixing → pr_ready
  | "merge"      // pr_ready → merged
  | "deploy_ok"  // merged → done
  | "fail"       // any active → failed
  | "ignore"     // reported → ignored
  | "reject";    // pr_ready → rejected

export const transitions: Record<TaskEvent, { from: TaskState[]; to: TaskState }> = {
  analyze:    { from: ["pending"],    to: "analyzing" },
  report:     { from: ["analyzing"],  to: "reported" },
  fix:        { from: ["reported"],   to: "fixing" },
  pr_created: { from: ["fixing"],     to: "pr_ready" },
  merge:      { from: ["pr_ready"],   to: "merged" },
  deploy_ok:  { from: ["merged"],     to: "done" },
  fail:       { from: ["pending", "analyzing", "fixing"], to: "failed" },
  ignore:     { from: ["reported"],   to: "ignored" },
  reject:     { from: ["pr_ready"],   to: "rejected" },
};

export type Task = {
  id: string;
  type: string;
  state: TaskState;
  sentryIssueId: string | null;
  sentryEventId: string | null;
  title: string;
  severity: string | null;
  analysis: string | null;
  prUrl: string | null;
  larkMessageId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
```

**Step 4: Write src/tasks/store.ts**

```typescript
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { transitions, type Task, type TaskEvent, type TaskState } from "./types.js";

type CreateParams = {
  sentryIssueId: string;
  sentryEventId: string;
  title: string;
  severity: string;
};

export class TaskStore {
  constructor(private db: Database.Database) {}

  create(params: CreateParams): Task {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks (id, sentry_issue_id, sentry_event_id, title, severity)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, params.sentryIssueId, params.sentryEventId, params.title, params.severity);

    return this.getById(id)!;
  }

  getById(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  findByIssueId(issueId: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE sentry_issue_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(issueId) as any;
    return row ? this.mapRow(row) : null;
  }

  transition(id: string, event: TaskEvent): Task {
    const task = this.getById(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    const rule = transitions[event];
    if (!rule.from.includes(task.state)) {
      throw new Error(
        `Invalid transition: cannot apply "${event}" to task in state "${task.state}"`,
      );
    }

    this.db
      .prepare("UPDATE tasks SET state = ?, updated_at = datetime('now') WHERE id = ?")
      .run(rule.to, id);

    this.audit(id, event, `${task.state} → ${rule.to}`);

    return this.getById(id)!;
  }

  updateAnalysis(id: string, analysis: string): void {
    this.db
      .prepare("UPDATE tasks SET analysis = ?, updated_at = datetime('now') WHERE id = ?")
      .run(analysis, id);
  }

  updatePrUrl(id: string, prUrl: string): void {
    this.db
      .prepare("UPDATE tasks SET pr_url = ?, updated_at = datetime('now') WHERE id = ?")
      .run(prUrl, id);
  }

  updateLarkMessageId(id: string, messageId: string): void {
    this.db
      .prepare("UPDATE tasks SET lark_message_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(messageId, id);
  }

  updateError(id: string, error: string): void {
    this.db
      .prepare("UPDATE tasks SET error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(error, id);
  }

  private audit(taskId: string, action: string, detail: string): void {
    this.db
      .prepare("INSERT INTO audit_log (task_id, action, detail) VALUES (?, ?, ?)")
      .run(taskId, action, detail);
  }

  private mapRow(row: any): Task {
    return {
      id: row.id,
      type: row.type,
      state: row.state as TaskState,
      sentryIssueId: row.sentry_issue_id,
      sentryEventId: row.sentry_event_id,
      title: row.title,
      severity: row.severity,
      analysis: row.analysis,
      prUrl: row.pr_url,
      larkMessageId: row.lark_message_id,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run test/tasks/store.test.ts
```

Expected: all 6 tests PASS.

**Step 6: Commit**

```bash
git add src/tasks/ test/tasks/ test/helpers.ts
git commit -m "feat: add task state machine and store"
```

---

### Task 4: Sentry webhook endpoint

**Files:**
- Create: `src/webhooks/sentry.ts`
- Test: `test/webhooks/sentry.test.ts`

**Step 1: Write the failing test**

Create `test/webhooks/sentry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { createTestDb } from "../helpers.js";
import { TaskStore } from "../../src/tasks/store.js";
import { sentryWebhook } from "../../src/webhooks/sentry.js";
import type Database from "better-sqlite3";

describe("POST /webhooks/sentry", () => {
  let app: Hono;
  let store: TaskStore;
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    app = new Hono();
    sentryWebhook(app, store);
  });

  it("creates a task from a valid Sentry alert", async () => {
    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "created",
        data: {
          issue: {
            id: "12345",
            title: "TypeError: Cannot read property 'name' of null",
            level: "error",
          },
          event: {
            event_id: "evt-aaa",
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBeDefined();
    expect(body.status).toBe("accepted");
  });

  it("deduplicates same issue", async () => {
    const payload = JSON.stringify({
      action: "created",
      data: {
        issue: { id: "99999", title: "Dup error", level: "error" },
        event: { event_id: "evt-bbb" },
      },
    });

    await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("duplicate");
  });

  it("rejects invalid payload", async () => {
    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bad: "data" }),
    });

    expect(res.status).toBe(400);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run test/webhooks/sentry.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write src/webhooks/sentry.ts**

```typescript
import type { Hono } from "hono";
import { z } from "zod";
import type { TaskStore } from "../tasks/store.js";

const sentryPayloadSchema = z.object({
  action: z.string(),
  data: z.object({
    issue: z.object({
      id: z.string(),
      title: z.string(),
      level: z.string(),
    }),
    event: z
      .object({
        event_id: z.string(),
      })
      .optional(),
  }),
});

export function sentryWebhook(
  app: Hono,
  store: TaskStore,
  onTaskCreated?: (taskId: string) => void,
): void {
  app.post("/webhooks/sentry", async (c) => {
    const parseResult = sentryPayloadSchema.safeParse(await c.req.json());
    if (!parseResult.success) {
      return c.json({ error: "Invalid payload" }, 400);
    }

    const { data } = parseResult.data;
    const issueId = data.issue.id;

    // Dedup: skip if an active task already exists for this issue
    const existing = store.findByIssueId(issueId);
    if (existing && !["done", "failed", "ignored", "rejected"].includes(existing.state)) {
      return c.json({ status: "duplicate", taskId: existing.id });
    }

    const task = store.create({
      sentryIssueId: issueId,
      sentryEventId: data.event?.event_id ?? "",
      title: data.issue.title,
      severity: mapSeverity(data.issue.level),
    });

    onTaskCreated?.(task.id);

    return c.json({ status: "accepted", taskId: task.id });
  });
}

function mapSeverity(level: string): string {
  switch (level) {
    case "fatal":
      return "P0";
    case "error":
      return "P1";
    case "warning":
      return "P2";
    default:
      return "P3";
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run test/webhooks/sentry.test.ts
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add src/webhooks/ test/webhooks/
git commit -m "feat: add Sentry webhook endpoint with dedup"
```

---

### Task 5: Sentry query MCP tool

**Files:**
- Create: `src/agent/tools/sentry-query.ts`
- Test: `test/agent/tools/sentry-query.test.ts`

**Step 1: Write the failing test**

Create `test/agent/tools/sentry-query.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createSentryQueryTool } from "../../src/agent/tools/sentry-query.js";

describe("sentry_query tool", () => {
  it("returns tool definition with correct name and schema", () => {
    const tool = createSentryQueryTool({
      authToken: "test-token",
      org: "test-org",
      project: "test-project",
    });

    expect(tool.name).toBe("sentry_query");
    expect(tool.description).toContain("Sentry");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run test/agent/tools/sentry-query.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write src/agent/tools/sentry-query.ts**

```typescript
import { z } from "zod";

type SentryConfig = {
  authToken: string;
  org: string;
  project: string;
};

/**
 * Creates a sentry_query tool definition for the Claude Agent SDK.
 * Uses the `tool()` helper from @anthropic-ai/claude-agent-sdk.
 */
export function createSentryQueryTool(config: SentryConfig) {
  // We import `tool` dynamically so tests can run without the full SDK.
  // At runtime, this is used inside createSdkMcpServer().
  return {
    name: "sentry_query",
    description:
      "Query Sentry for issue details including error message, stacktrace, affected users, and frequency. Use this to understand the error before reading code.",
    inputSchema: {
      issue_id: z.string().describe("Sentry issue ID"),
    },
    handler: async (args: { issue_id: string }) => {
      const url = `https://sentry.io/api/0/organizations/${config.org}/issues/${args.issue_id}/`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.authToken}` },
      });

      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `Sentry API error: ${res.status} ${res.statusText}` }],
          isError: true,
        };
      }

      const issue = (await res.json()) as Record<string, unknown>;

      // Fetch latest event for stacktrace
      const eventUrl = `https://sentry.io/api/0/organizations/${config.org}/issues/${args.issue_id}/events/latest/`;
      const eventRes = await fetch(eventUrl, {
        headers: { Authorization: `Bearer ${config.authToken}` },
      });
      const event = eventRes.ok ? ((await eventRes.json()) as Record<string, unknown>) : null;

      const summary = {
        id: issue.id,
        title: issue.title,
        level: issue.level,
        count: issue.count,
        userCount: issue.userCount,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        status: issue.status,
        stacktrace: event ? extractStacktrace(event) : "unavailable",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  };
}

function extractStacktrace(event: Record<string, unknown>): string {
  try {
    const entries = (event as any).entries ?? [];
    for (const entry of entries) {
      if (entry.type === "exception") {
        const values = entry.data?.values ?? [];
        return values
          .map((v: any) => {
            const frames = v.stacktrace?.frames ?? [];
            const topFrames = frames.slice(-5).reverse();
            return [
              `${v.type}: ${v.value}`,
              ...topFrames.map(
                (f: any) => `  at ${f.function ?? "?"} (${f.filename}:${f.lineNo})`,
              ),
            ].join("\n");
          })
          .join("\n\n");
      }
    }
  } catch {
    // fall through
  }
  return "Could not extract stacktrace";
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run test/agent/tools/sentry-query.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/tools/ test/agent/
git commit -m "feat: add sentry_query MCP tool"
```

---

### Task 6: Claude Agent SDK runner

**Files:**
- Create: `src/agent/runner.ts`
- Test: `test/agent/runner.test.ts`

**Step 1: Write the failing test**

Create `test/agent/runner.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildAgentOptions } from "../../src/agent/runner.js";

describe("buildAgentOptions", () => {
  it("returns valid options with MCP tools and system prompt", () => {
    const opts = buildAgentOptions({
      workspaceDir: "/tmp/test-repo",
      sentryConfig: { authToken: "t", org: "o", project: "p" },
      skillContent: "You are a fault healer.",
      maxBudgetUsd: 1.0,
    });

    expect(opts.cwd).toBe("/tmp/test-repo");
    expect(opts.systemPrompt).toContain("fault healer");
    expect(opts.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(opts.mcpServers).toBeDefined();
    expect(opts.maxBudgetUsd).toBe(1.0);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run test/agent/runner.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write src/agent/runner.ts**

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createSentryQueryTool } from "./tools/sentry-query.js";

type AgentConfig = {
  workspaceDir: string;
  sentryConfig: { authToken: string; org: string; project: string };
  skillContent: string;
  maxBudgetUsd?: number;
  env?: Record<string, string>;
};

type AgentResult = {
  text: string;
  sessionId: string;
  costUsd: number;
  error?: string;
};

/**
 * Build Claude Agent SDK options. Exported for testing.
 */
export function buildAgentOptions(config: AgentConfig) {
  const sentryTool = createSentryQueryTool(config.sentryConfig);

  // Create in-process MCP server with custom tools
  const mcpServer = createSdkMcpServer({
    name: "ai-hub-tools",
    tools: [
      tool(
        sentryTool.name,
        sentryTool.description,
        sentryTool.inputSchema,
        sentryTool.handler,
      ),
    ],
  });

  return {
    cwd: config.workspaceDir,
    systemPrompt: config.skillContent,
    tools: { type: "preset" as const, preset: "claude_code" as const },
    mcpServers: {
      "ai-hub-tools": mcpServer,
    },
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    maxTurns: 30,
    maxBudgetUsd: config.maxBudgetUsd ?? 2.0,
    env: {
      ...process.env,
      ...(config.env ?? {}),
    },
  };
}

/**
 * Run the Claude agent with a prompt.
 * Returns the final text result and metadata.
 */
export async function runAgent(
  prompt: string,
  config: AgentConfig,
  opts?: { abortSignal?: AbortSignal },
): Promise<AgentResult> {
  const options = buildAgentOptions(config);

  const abortController = new AbortController();
  if (opts?.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => abortController.abort());
  }

  const q = query({
    prompt,
    options: {
      ...options,
      abortController,
    },
  });

  let resultText = "";
  let sessionId = "";
  let costUsd = 0;
  let error: string | undefined;

  for await (const message of q) {
    if (message.type === "result") {
      sessionId = message.session_id;
      costUsd = message.total_cost_usd;
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        error = message.errors?.join("; ") ?? "Agent run failed";
      }
    }
  }

  return { text: resultText, sessionId, costUsd, error };
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run test/agent/runner.test.ts
```

Expected: PASS (buildAgentOptions is a pure function test).

**Step 5: Commit**

```bash
git add src/agent/runner.ts test/agent/runner.test.ts
git commit -m "feat: add Claude Agent SDK runner wrapper"
```

---

### Task 7: Fault healing skill

**Files:**
- Create: `src/skills/fault-healing.md`

**Step 1: Write the skill file**

Create `src/skills/fault-healing.md`:

```markdown
# Fault Healing Assistant

You are an AI assistant that diagnoses and fixes software bugs from Sentry error reports.

## Phase: Analysis

When asked to **analyze** a Sentry issue:

1. Use the `sentry_query` tool to get error details and stacktrace
2. Read the affected source files to understand context
3. Search for related code with grep/glob if needed
4. Identify the root cause
5. Assess severity and confidence level

Output a structured diagnosis:
- **Error type**: The exception/error class
- **Root cause**: What went wrong and why
- **Affected files**: List of files involved
- **Impact**: How many users affected, frequency
- **Confidence**: Low (<60%), Medium (60-85%), High (>85%)
- **Recommended fix**: Brief description of the fix

### Decision rules
- If confidence < 60%: recommend manual investigation
- If change would affect > 50 lines: flag as complex
- If change involves database schema: flag as HIGH RISK, do NOT auto-fix

## Phase: Fix

When asked to **fix** the issue:

1. Create a new git branch: `fix/sentry-{issue_id}`
2. Make the minimal code change to fix the root cause
3. Add a regression test that reproduces the original error
4. Run the existing test suite: `npm test` (or equivalent)
5. If tests pass, create a PR using `gh pr create`

### Fix principles
- Minimal change — fix the bug, don't refactor surrounding code
- Always add a test that would have caught this bug
- Commit message format: `fix: {brief description} (sentry #{issue_id})`
- PR description must include: root cause, fix description, test plan

### Safety rules
- NEVER force push or modify protected branches
- NEVER modify database schemas
- NEVER delete files unless the deletion IS the fix
- If tests fail after your fix, revert and report failure
```

**Step 2: Commit**

```bash
git add src/skills/fault-healing.md
git commit -m "feat: add fault-healing skill"
```

---

### Task 8: Lark integration

**Files:**
- Create: `src/lark/notify.ts`
- Create: `src/lark/callback.ts`
- Test: `test/lark/notify.test.ts`

**Step 1: Write the failing test**

Create `test/lark/notify.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildDiagnosisCard, buildPrReadyCard } from "../../src/lark/notify.js";

describe("Lark card builders", () => {
  it("builds diagnosis card with correct structure", () => {
    const card = buildDiagnosisCard({
      taskId: "task-1",
      title: "TypeError at handler.ts:42",
      severity: "P1",
      rootCause: "Null reference in user lookup",
      confidence: "92%",
      impact: "1.2k users",
    });

    expect(card.header.title.content).toContain("P1");
    // Should have action buttons
    const actions = card.elements.find((e: any) => e.tag === "action");
    expect(actions).toBeDefined();
  });

  it("builds PR ready card with correct structure", () => {
    const card = buildPrReadyCard({
      taskId: "task-2",
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      filesChanged: 3,
      linesAdded: 12,
      testsPassed: 8,
      testsFailed: 0,
    });

    expect(card.header.title.content).toContain("PR");
    const actions = card.elements.find((e: any) => e.tag === "action");
    expect(actions).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run test/lark/notify.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write src/lark/notify.ts**

```typescript
import * as lark from "@larksuiteoapi/node-sdk";

type LarkConfig = {
  appId: string;
  appSecret: string;
};

let _client: lark.Client | null = null;

export function getLarkClient(config: LarkConfig): lark.Client {
  if (!_client) {
    _client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: lark.AppType.SelfBuild,
    });
  }
  return _client;
}

type DiagnosisCardParams = {
  taskId: string;
  title: string;
  severity: string;
  rootCause: string;
  confidence: string;
  impact: string;
};

export function buildDiagnosisCard(params: DiagnosisCardParams) {
  return {
    header: {
      title: {
        tag: "plain_text",
        content: `🔴 ${params.severity} 故障告警`,
      },
      template: "red",
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `**错误:** ${params.title}` } },
      { tag: "div", text: { tag: "lark_md", content: `**根因:** ${params.rootCause}` } },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**置信度:** ${params.confidence} | **影响:** ${params.impact}`,
        },
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔧 生成修复" },
            type: "primary",
            value: { action: "fix", taskId: params.taskId },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "👀 查看详情" },
            value: { action: "view", taskId: params.taskId },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🚫 忽略" },
            type: "danger",
            value: { action: "ignore", taskId: params.taskId },
          },
        ],
      },
    ],
  };
}

type PrReadyCardParams = {
  taskId: string;
  prUrl: string;
  prNumber: number;
  filesChanged: number;
  linesAdded: number;
  testsPassed: number;
  testsFailed: number;
};

export function buildPrReadyCard(params: PrReadyCardParams) {
  return {
    header: {
      title: {
        tag: "plain_text",
        content: "✅ 修复 PR 已就绪",
      },
      template: "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**PR #${params.prNumber}** | 改动: ${params.filesChanged}文件 +${params.linesAdded}行`,
        },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**测试:** ${params.testsPassed}通过 ${params.testsFailed}失败 | **CI:** ${params.testsFailed === 0 ? "✅ 通过" : "❌ 失败"}`,
        },
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ 合并 PR" },
            type: "primary",
            value: { action: "merge", taskId: params.taskId },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "📝 查看代码" },
            url: params.prUrl,
            type: "default",
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔄 要求修改" },
            value: { action: "reject", taskId: params.taskId },
          },
        ],
      },
    ],
  };
}

export async function sendLarkCard(
  client: lark.Client,
  chatId: string,
  card: ReturnType<typeof buildDiagnosisCard | typeof buildPrReadyCard>,
): Promise<string | null> {
  try {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({ config: { wide_screen_mode: true }, ...card }),
      },
    });
    return res.data?.message_id ?? null;
  } catch (err) {
    console.error("[lark] Failed to send card:", err);
    return null;
  }
}
```

**Step 4: Write src/lark/callback.ts**

```typescript
import type { Hono } from "hono";
import type { TaskStore } from "../tasks/store.js";

type CallbackAction = "fix" | "merge" | "ignore" | "reject" | "view";

type OnAction = (taskId: string, action: CallbackAction) => void | Promise<void>;

export function larkCallback(app: Hono, store: TaskStore, onAction: OnAction): void {
  app.post("/callbacks/lark", async (c) => {
    const body = await c.req.json();

    // Lark card callback verification challenge
    if (body.challenge) {
      return c.json({ challenge: body.challenge });
    }

    // Extract action from card callback
    const action = body.action?.value as { action?: CallbackAction; taskId?: string } | undefined;
    if (!action?.action || !action?.taskId) {
      return c.json({ msg: "ok" });
    }

    const task = store.getById(action.taskId);
    if (!task) {
      return c.json({ msg: "task not found" });
    }

    await onAction(action.taskId, action.action);

    return c.json({ msg: "ok" });
  });
}
```

**Step 5: Run tests to verify they pass**

```bash
npx vitest run test/lark/notify.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/lark/ test/lark/
git commit -m "feat: add Lark notification cards and callback handler"
```

---

### Task 9: Fault healing workflow

**Files:**
- Create: `src/workflows/fault-healing.ts`
- Test: `test/workflows/fault-healing.test.ts`

This is the core orchestration that wires everything together. It implements the state machine transitions for the fault healing flow.

**Step 1: Write the failing test**

Create `test/workflows/fault-healing.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestDb } from "../helpers.js";
import { TaskStore } from "../../src/tasks/store.js";
import { FaultHealingWorkflow } from "../../src/workflows/fault-healing.js";
import type Database from "better-sqlite3";

describe("FaultHealingWorkflow", () => {
  let db: Database.Database;
  let store: TaskStore;
  let workflow: FaultHealingWorkflow;

  const mockRunAgent = vi.fn();
  const mockSendCard = vi.fn().mockResolvedValue("msg-123");

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    workflow = new FaultHealingWorkflow({
      store,
      runAgent: mockRunAgent,
      sendLarkCard: mockSendCard,
    });
    mockRunAgent.mockReset();
    mockSendCard.mockReset().mockResolvedValue("msg-123");
  });

  it("runs analysis phase: pending → analyzing → reported", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-1",
      sentryEventId: "evt-1",
      title: "TypeError",
      severity: "P1",
    });

    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        rootCause: "Null ref",
        confidence: "92%",
        impact: "1.2k users",
        affectedFiles: ["handler.ts"],
      }),
      sessionId: "sess-1",
      costUsd: 0.05,
    });

    await workflow.runAnalysis(task.id);

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("reported");
    expect(updated?.analysis).toContain("Null ref");
    expect(mockSendCard).toHaveBeenCalledOnce();
  });

  it("handles analysis failure gracefully", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-2",
      sentryEventId: "evt-2",
      title: "Error",
      severity: "P1",
    });

    mockRunAgent.mockResolvedValueOnce({
      text: "",
      sessionId: "sess-2",
      costUsd: 0.03,
      error: "Context overflow",
    });

    await workflow.runAnalysis(task.id);

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("failed");
    expect(updated?.error).toContain("Context overflow");
  });

  it("runs fix phase: reported → fixing → pr_ready", async () => {
    const task = store.create({
      sentryIssueId: "ISSUE-3",
      sentryEventId: "evt-3",
      title: "TypeError",
      severity: "P1",
    });
    store.transition(task.id, "analyze");
    store.transition(task.id, "report");

    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        prUrl: "https://github.com/org/repo/pull/42",
        prNumber: 42,
        filesChanged: 2,
        linesAdded: 8,
        testsPassed: 15,
        testsFailed: 0,
      }),
      sessionId: "sess-3",
      costUsd: 0.12,
    });

    await workflow.runFix(task.id);

    const updated = store.getById(task.id);
    expect(updated?.state).toBe("pr_ready");
    expect(updated?.prUrl).toContain("/pull/42");
    expect(mockSendCard).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run test/workflows/fault-healing.test.ts
```

Expected: FAIL — module not found.

**Step 3: Write src/workflows/fault-healing.ts**

```typescript
import type { TaskStore } from "../tasks/store.js";
import type { Task } from "../tasks/types.js";

type AgentResult = {
  text: string;
  sessionId: string;
  costUsd: number;
  error?: string;
};

type WorkflowDeps = {
  store: TaskStore;
  runAgent: (prompt: string) => Promise<AgentResult>;
  sendLarkCard: (card: any) => Promise<string | null>;
};

export class FaultHealingWorkflow {
  constructor(private deps: WorkflowDeps) {}

  /**
   * Phase 1: Analysis
   * pending → analyzing → reported (or failed)
   */
  async runAnalysis(taskId: string): Promise<void> {
    const { store, runAgent, sendLarkCard } = this.deps;

    const task = store.getById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Transition to analyzing
    store.transition(taskId, "analyze");

    const prompt = `Analyze Sentry issue #${task.sentryIssueId}.

Use the sentry_query tool with issue_id "${task.sentryIssueId}" to get the error details.

Then read the relevant source code files and determine the root cause.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "rootCause": "brief description of the root cause",
  "confidence": "percentage like 85%",
  "impact": "affected users / frequency",
  "affectedFiles": ["file1.ts", "file2.ts"],
  "suggestedFix": "brief description of the fix",
  "complexity": "low|medium|high"
}`;

    const result = await runAgent(prompt);

    if (result.error || !result.text) {
      store.updateError(taskId, result.error ?? "Empty analysis result");
      store.transition(taskId, "fail");
      return;
    }

    // Store raw analysis
    store.updateAnalysis(taskId, result.text);

    // Parse analysis for Lark card
    let parsed: any;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      // If AI didn't return clean JSON, use raw text
      parsed = {
        rootCause: result.text.slice(0, 200),
        confidence: "unknown",
        impact: "unknown",
      };
    }

    // Transition to reported
    store.transition(taskId, "report");

    // Send Lark diagnosis card
    const { buildDiagnosisCard } = await import("../lark/notify.js");
    const card = buildDiagnosisCard({
      taskId,
      title: task.title,
      severity: task.severity ?? "P3",
      rootCause: parsed.rootCause ?? "See analysis",
      confidence: parsed.confidence ?? "unknown",
      impact: parsed.impact ?? "unknown",
    });

    const messageId = await sendLarkCard(card);
    if (messageId) {
      store.updateLarkMessageId(taskId, messageId);
    }
  }

  /**
   * Phase 2: Fix
   * reported → fixing → pr_ready (or failed)
   */
  async runFix(taskId: string): Promise<void> {
    const { store, runAgent, sendLarkCard } = this.deps;

    const task = store.getById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Transition to fixing
    store.transition(taskId, "fix");

    const prompt = `Fix Sentry issue #${task.sentryIssueId}.

Previous analysis:
${task.analysis}

Steps:
1. Create branch: fix/sentry-${task.sentryIssueId}
2. Make the minimal code fix based on the analysis
3. Add a regression test
4. Run the test suite
5. If tests pass, create a PR with: gh pr create --title "fix: ${task.title} (sentry #${task.sentryIssueId})" --body "..."

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "prUrl": "the PR URL",
  "prNumber": 42,
  "filesChanged": 2,
  "linesAdded": 10,
  "testsPassed": 15,
  "testsFailed": 0
}

If you cannot fix it or tests fail, respond with:
{
  "error": "description of what went wrong"
}`;

    const result = await runAgent(prompt);

    if (result.error || !result.text) {
      store.updateError(taskId, result.error ?? "Empty fix result");
      store.transition(taskId, "fail");
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      store.updateError(taskId, "AI returned non-JSON response");
      store.transition(taskId, "fail");
      return;
    }

    if (parsed.error) {
      store.updateError(taskId, parsed.error);
      store.transition(taskId, "fail");
      return;
    }

    // Store PR URL and transition
    store.updatePrUrl(taskId, parsed.prUrl);
    store.transition(taskId, "pr_created");

    // Send Lark PR ready card
    const { buildPrReadyCard } = await import("../lark/notify.js");
    const card = buildPrReadyCard({
      taskId,
      prUrl: parsed.prUrl,
      prNumber: parsed.prNumber ?? 0,
      filesChanged: parsed.filesChanged ?? 0,
      linesAdded: parsed.linesAdded ?? 0,
      testsPassed: parsed.testsPassed ?? 0,
      testsFailed: parsed.testsFailed ?? 0,
    });

    const messageId = await sendLarkCard(card);
    if (messageId) {
      store.updateLarkMessageId(taskId, messageId);
    }
  }

  /**
   * Handle approval callback from Lark.
   */
  async handleAction(taskId: string, action: string): Promise<void> {
    const { store } = this.deps;

    switch (action) {
      case "fix":
        await this.runFix(taskId);
        break;
      case "merge":
        store.transition(taskId, "merge");
        // TODO: trigger actual PR merge via gh CLI
        break;
      case "ignore":
        store.transition(taskId, "ignore");
        break;
      case "reject":
        store.transition(taskId, "reject");
        break;
      default:
        console.warn(`Unknown action: ${action}`);
    }
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run test/workflows/fault-healing.test.ts
```

Expected: all 3 tests PASS.

**Step 5: Commit**

```bash
git add src/workflows/ test/workflows/
git commit -m "feat: add fault healing workflow orchestration"
```

---

### Task 10: Server assembly + entry point

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`

**Step 1: Write src/server.ts**

```typescript
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { TaskStore } from "./tasks/store.js";
import { sentryWebhook } from "./webhooks/sentry.js";
import { runAgent } from "./agent/runner.js";
import { getLarkClient, sendLarkCard } from "./lark/notify.js";
import { larkCallback } from "./lark/callback.js";
import { FaultHealingWorkflow } from "./workflows/fault-healing.js";

export function createApp() {
  const env = loadEnv();
  const db = createDb(resolve("ai-hub.db"));
  const store = new TaskStore(db);
  const larkClient = getLarkClient({ appId: env.LARK_APP_ID, appSecret: env.LARK_APP_SECRET });

  // Load skill content
  const skillPath = resolve(import.meta.dirname, "skills", "fault-healing.md");
  const skillContent = readFileSync(skillPath, "utf-8");

  // Build agent config
  const agentConfig = {
    workspaceDir: env.WORKSPACE_DIR,
    sentryConfig: {
      authToken: env.SENTRY_AUTH_TOKEN,
      org: env.SENTRY_ORG,
      project: env.SENTRY_PROJECT,
    },
    skillContent,
    env: { GH_TOKEN: env.GH_TOKEN },
  };

  // Create workflow
  const workflow = new FaultHealingWorkflow({
    store,
    runAgent: (prompt) => runAgent(prompt, agentConfig),
    sendLarkCard: (card) => sendLarkCard(larkClient, env.LARK_NOTIFY_CHAT_ID, card),
  });

  // Build Hono app
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // Task status
  app.get("/tasks/:id", (c) => {
    const task = store.getById(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  // Sentry webhook — triggers analysis asynchronously
  sentryWebhook(app, store, (taskId) => {
    workflow.runAnalysis(taskId).catch((err) => {
      console.error(`[workflow] Analysis failed for task ${taskId}:`, err);
    });
  });

  // Lark callback — handles button clicks
  larkCallback(app, store, (taskId, action) => {
    workflow.handleAction(taskId, action).catch((err) => {
      console.error(`[workflow] Action "${action}" failed for task ${taskId}:`, err);
    });
  });

  return { app, db, store, workflow };
}

export function startServer() {
  const env = loadEnv();
  const { app } = createApp();

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`
AI Hub 服务已启动

  地址:     http://localhost:${info.port}
  健康检查: http://localhost:${info.port}/health

  Webhooks:
    Sentry:  POST http://localhost:${info.port}/webhooks/sentry
    飞书:    POST http://localhost:${info.port}/callbacks/lark
`);
  });
}
```

**Step 2: Write src/index.ts**

```typescript
import "dotenv/config";
import { startServer } from "./server.js";

startServer();
```

**Step 3: Install dotenv**

```bash
npm install dotenv
```

**Step 4: Verify the build compiles**

```bash
npx tsc --noEmit
```

Expected: No errors (or only type errors from missing env at compile time, which is OK).

**Step 5: Commit**

```bash
git add src/server.ts src/index.ts
git commit -m "feat: add server assembly and entry point"
```

---

### Task 11: End-to-end manual test

**Step 1: Create a minimal .env file**

Copy `.env.example` to `.env` and fill in real values.

**Step 2: Start the server**

```bash
npm run dev
```

Expected: Server starts on port 8080.

**Step 3: Test health check**

```bash
curl http://localhost:8080/health
```

Expected: `{"status":"ok","timestamp":...}`

**Step 4: Test Sentry webhook**

```bash
curl -X POST http://localhost:8080/webhooks/sentry \
  -H "Content-Type: application/json" \
  -d '{
    "action": "created",
    "data": {
      "issue": {
        "id": "test-001",
        "title": "TypeError: Cannot read property name of null",
        "level": "error"
      },
      "event": { "event_id": "evt-test-001" }
    }
  }'
```

Expected: `{"status":"accepted","taskId":"..."}`

**Step 5: Verify task was created**

```bash
curl http://localhost:8080/tasks/<taskId from step 4>
```

Expected: Task JSON with state progressing through analyzing → reported.

**Step 6: Check Lark for the diagnosis card notification**

Expected: A card message appears in the configured Lark chat with error details and action buttons.

**Step 7: Click "生成修复" in Lark card**

Expected: AI starts fixing, creates a branch, runs tests, creates a PR. A new card appears with PR details.

**Step 8: Commit any fixes needed**

```bash
git add -A
git commit -m "fix: end-to-end test adjustments"
```

---

## Summary

| Task | Description | Key files | Estimated |
|------|-------------|-----------|-----------|
| 1 | Project scaffolding | package.json, tsconfig.json | 15 min |
| 2 | Env config + Database | src/env.ts, src/db.ts | 20 min |
| 3 | Task state machine | src/tasks/types.ts, src/tasks/store.ts | 30 min |
| 4 | Sentry webhook | src/webhooks/sentry.ts | 20 min |
| 5 | Sentry query tool | src/agent/tools/sentry-query.ts | 20 min |
| 6 | Claude SDK runner | src/agent/runner.ts | 25 min |
| 7 | Fault healing skill | src/skills/fault-healing.md | 10 min |
| 8 | Lark integration | src/lark/notify.ts, src/lark/callback.ts | 30 min |
| 9 | Workflow orchestration | src/workflows/fault-healing.ts | 40 min |
| 10 | Server assembly | src/server.ts, src/index.ts | 20 min |
| 11 | E2E manual test | — | 30 min |
| **Total** | | **~15 files** | **~4 hours** |
