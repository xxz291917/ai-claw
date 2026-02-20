# Agent Autonomy Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the orchestration layer (Core, RuleRouter, Executor, SubAgent, state machine) and let agents run autonomously via tools + skills. EventBus becomes EventLog (audit-only).

**Architecture:** Sentry webhook handler directly calls Agent Runner with the fault-healing skill. No state machine, no multi-phase workflow. Human review happens at GitHub PR level, not Lark card buttons. EventLog persists events for audit.

**Tech Stack:** TypeScript, Hono, better-sqlite3, Vitest

---

### Task 1: Downgrade EventBus to EventLog

**Files:**
- Modify: `src/core/event-bus.ts`
- Modify: `test/core/event-bus.test.ts`

**Step 1: Rewrite EventBus as EventLog**

Replace the full contents of `src/core/event-bus.ts` with:

```typescript
import type Database from "better-sqlite3";
import type { HubEvent } from "./hub-event.js";

export class EventLog {
  constructor(private db: Database.Database) {}

  log(event: HubEvent): void {
    this.db
      .prepare(
        "INSERT INTO event_log (id, type, source, payload, context) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.type,
        event.source,
        JSON.stringify(event.payload),
        event.context ? JSON.stringify(event.context) : null,
      );
  }
}
```

**Step 2: Update tests**

Replace `test/core/event-bus.test.ts` with:

```typescript
import { describe, it, expect } from "vitest";
import { EventLog } from "../../src/core/event-bus.js";
import { createHubEvent } from "../../src/core/hub-event.js";
import { createTestDb } from "../helpers.js";

describe("EventLog", () => {
  it("persists events to event_log table", () => {
    const db = createTestDb();
    const log = new EventLog(db);

    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issue_id: "42" },
      context: { userId: "u1" },
    });
    log.log(event);

    const row = db.prepare("SELECT * FROM event_log WHERE id = ?").get(event.id) as any;
    expect(row).toBeTruthy();
    expect(row.type).toBe("sentry.issue_alert");
    expect(row.source).toBe("sentry");
    expect(JSON.parse(row.payload)).toEqual({ issue_id: "42" });
    expect(JSON.parse(row.context)).toEqual({ userId: "u1" });
  });

  it("stores null context when not provided", () => {
    const db = createTestDb();
    const log = new EventLog(db);

    const event = createHubEvent({
      type: "chat.web",
      source: "web",
      payload: { msg: "hi" },
    });
    log.log(event);

    const row = db.prepare("SELECT * FROM event_log WHERE id = ?").get(event.id) as any;
    expect(row.context).toBeNull();
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run test/core/event-bus.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/core/event-bus.ts test/core/event-bus.test.ts
git commit -m "refactor: downgrade EventBus to EventLog (audit-only)"
```

---

### Task 2: Delete orchestration layer files

**Files:**
- Delete: `src/core/core.ts`
- Delete: `src/core/executor.ts`
- Delete: `src/core/rule-router.ts`
- Delete: `src/agents/registry.ts`
- Delete: `src/agents/types.ts`
- Delete: `src/agents/fault-healing.ts`
- Delete: `src/routes/fault-healing.ts`
- Delete: `src/workflows/fault-healing.ts`
- Delete: `src/tasks/types.ts`
- Delete: `src/tasks/store.ts`
- Delete: `src/lark/callback.ts`
- Delete: `src/adapters/input/sentry.ts`
- Delete: `src/adapters/input/lark.ts`
- Delete: `src/adapters/input/web-chat.ts`
- Delete: `src/adapters/input/types.ts`
- Delete: `src/adapters/output/types.ts`
- Delete: `src/adapters/output/lark.ts`
- Delete: `test/core/core.test.ts`
- Delete: `test/core/executor.test.ts`
- Delete: `test/core/rule-router.test.ts`
- Delete: `test/agents/registry.test.ts`
- Delete: `test/agents/fault-healing.test.ts`
- Delete: `test/adapters/input/sentry.test.ts`
- Delete: `test/adapters/input/lark.test.ts`
- Delete: `test/adapters/input/web-chat.test.ts`
- Delete: `test/adapters/output/lark.test.ts`
- Delete: `test/workflows/fault-healing.test.ts`
- Delete: `test/tasks/store.test.ts`

**Step 1: Delete all orchestration source files**

```bash
rm src/core/core.ts src/core/executor.ts src/core/rule-router.ts
rm src/agents/registry.ts src/agents/types.ts src/agents/fault-healing.ts
rm src/routes/fault-healing.ts
rm src/workflows/fault-healing.ts
rm src/tasks/types.ts src/tasks/store.ts
rm src/lark/callback.ts
rm -rf src/adapters/
```

**Step 2: Delete corresponding test files**

```bash
rm test/core/core.test.ts test/core/executor.test.ts test/core/rule-router.test.ts
rm test/agents/registry.test.ts test/agents/fault-healing.test.ts
rm test/workflows/fault-healing.test.ts test/tasks/store.test.ts
rm -rf test/adapters/
```

**Step 3: Run all tests to check nothing imports deleted files**

Run: `npx vitest run`
Expected: Some tests will FAIL (server.ts, router.ts, webhooks.ts still import deleted modules). That's expected — Task 3 and Task 4 fix these.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete orchestration layer (Core, SubAgent, state machine, adapters)"
```

---

### Task 3: Simplify chat router (remove EventBus/adapter dependencies)

The chat router currently depends on `EventBus` and `WebChatInputAdapter` for audit logging. Replace with `EventLog` and inline event creation.

**Files:**
- Modify: `src/chat/router.ts`
- Modify: `test/chat/router.test.ts`

**Step 1: Update chat router**

In `src/chat/router.ts`, make these changes:

1. Replace imports:
   - `EventBus` → `EventLog`
   - Remove `WebChatInputAdapter` import
   - Add `createHubEvent` import

2. Update `ChatRouterDeps`:
   ```typescript
   type ChatRouterDeps = {
     sessionManager: SessionManager;
     eventLog: EventLog;
     maxHistoryMessages?: number;
     memoryManager?: MemoryManager;
   };
   ```

3. In `chatRouter` function, replace destructuring:
   ```typescript
   const { sessionManager, eventLog, memoryManager } = deps;
   ```

4. Replace the audit logging block (around line 186-192) with:
   ```typescript
   // Audit log (async, non-blocking)
   try {
     eventLog.log(createHubEvent({
       type: "chat.web",
       source: "web_chat",
       payload: { message },
       context: { sessionId: session.id },
     }));
   } catch { /* best-effort */ }
   ```

**Step 2: Update router tests**

In `test/chat/router.test.ts`:

1. Replace imports:
   - `EventBus` → `EventLog`
   - Remove `WebChatInputAdapter` import
   - Add `createHubEvent` if needed

2. Update `setup` function:
   ```typescript
   function setup(events: ChatEvent[]) {
     const db = createTestDb();
     const app = new Hono();
     const provider = mockProvider(events);
     const sessionManager = new SessionManager(db);
     const eventLog = new EventLog(db);

     chatRouter(app, provider, { sessionManager, eventLog });
     return { app, sessionManager, eventLog };
   }
   ```

3. Update all test cases that create `EventBus`/`WebChatInputAdapter` to use `EventLog` instead.

**Step 3: Run tests**

Run: `npx vitest run test/chat/router.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/chat/router.ts test/chat/router.test.ts
git commit -m "refactor: chat router uses EventLog instead of EventBus"
```

---

### Task 4: Simplify server.ts and webhook routes

This is the main wiring task. Remove all orchestration initialization and simplify the Sentry webhook to directly call Agent Runner.

**Files:**
- Modify: `src/server.ts`
- Modify: `src/routes/webhooks.ts`
- Modify: `src/lark/notify.ts`
- Modify: `test/lark/notify.test.ts`
- Modify: `test/webhooks/sentry.test.ts`

**Step 1: Simplify Lark notify (notification-only cards)**

In `src/lark/notify.ts`:

1. Remove `buildDiagnosisCard` and `buildPrReadyCard` (interactive cards with approval buttons).
2. Add a simple `buildNotificationCard`:

```typescript
export type NotificationCardParams = {
  title: string;
  severity: string;
  body: string;
  linkUrl?: string;
  linkLabel?: string;
};

export function buildNotificationCard(params: NotificationCardParams) {
  const elements: any[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: params.body },
    },
  ];

  if (params.linkUrl) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: params.linkLabel ?? "查看详情" },
          url: params.linkUrl,
          type: "primary",
        },
      ],
    });
  }

  const templateColor = params.severity === "P0" || params.severity === "P1" ? "red" : "orange";

  return {
    header: {
      title: { tag: "plain_text", content: `${params.severity} ${params.title}` },
      template: templateColor,
    },
    elements,
  };
}
```

Keep `getLarkClient` and `sendLarkCard` unchanged (they're generic).

**Step 2: Rewrite webhook routes**

Replace `src/routes/webhooks.ts` with a simplified version that:
- Validates Sentry payload with Zod (inline, no adapter)
- Deduplicates by checking `event_log` table directly (no TaskStore)
- Records a minimal task row in `tasks` table
- Calls Agent Runner fire-and-forget
- Logs event to EventLog

```typescript
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { EventLog } from "../core/event-bus.js";
import { createHubEvent } from "../core/hub-event.js";

type AgentRunner = (prompt: string) => Promise<{ text: string; error?: string }>;

type WebhookDeps = {
  db: Database.Database;
  eventLog: EventLog;
  runFaultHealing: AgentRunner;
};

const sentryPayloadSchema = z.object({
  action: z.string(),
  data: z.object({
    issue: z.object({
      id: z.string(),
      title: z.string(),
      level: z.string(),
    }),
    event: z.object({ event_id: z.string() }).optional(),
  }),
});

function mapSeverity(level: string): string {
  switch (level) {
    case "fatal": return "P0";
    case "error": return "P1";
    case "warning": return "P2";
    default: return "P3";
  }
}

export function registerWebhookRoutes(app: Hono, deps: WebhookDeps): void {
  const { db, eventLog, runFaultHealing } = deps;

  app.post("/webhooks/sentry", async (c) => {
    const parsed = sentryPayloadSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid payload" }, 400);

    const { data } = parsed.data;
    const issueId = data.issue.id;

    // Dedup: skip if a running task already exists for this issue
    const existing = db
      .prepare("SELECT id, status FROM tasks WHERE sentry_issue_id = ? AND status = 'running' LIMIT 1")
      .get(issueId) as { id: string } | undefined;
    if (existing) {
      return c.json({ status: "duplicate", taskId: existing.id });
    }

    // Create minimal task record
    const taskId = randomUUID();
    const severity = mapSeverity(data.issue.level);
    db.prepare(
      "INSERT INTO tasks (id, sentry_issue_id, title, severity, status) VALUES (?, ?, ?, ?, 'running')",
    ).run(taskId, issueId, data.issue.title, severity);

    // Audit log
    eventLog.log(createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issueId, title: data.issue.title, severity, taskId },
    }));

    // Fire-and-forget: agent handles everything
    const prompt = `Sentry issue #${issueId}: "${data.issue.title}" (${severity}).
Analyze and fix this issue. Use sentry_query, read source code, create a fix, run tests, and submit a PR.`;

    runFaultHealing(prompt)
      .then((result) => {
        const status = result.error ? "failed" : "done";
        db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?")
          .run(status, taskId);
      })
      .catch((err) => {
        console.error(`[fault-healing] Agent failed for task ${taskId}:`, err);
        db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
          .run(String(err), taskId);
      });

    return c.json({ status: "accepted", taskId });
  });
}
```

**Step 3: Update the tasks table schema in db.ts**

In `src/db.ts`, replace the `tasks` table DDL with:

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  sentry_issue_id TEXT,
  title TEXT NOT NULL,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  pr_url TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Remove columns: `type`, `state`, `sentry_event_id`, `analysis`, `lark_message_id`.
Change: `state` → `status` (simpler: running/done/failed).

Also update `audit_log` to drop the FK constraint on tasks since we no longer need strict referential integrity:

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Step 4: Rewrite server.ts**

Replace `src/server.ts` to remove all orchestration imports and wiring:

1. Remove imports: `Core`, `RuleRouter`, `Executor`, `AgentRegistry`, `FaultHealingWorkflow`, `FaultHealingAgent`, `faultHealingRoutes`, `SentryInputAdapter`, `LarkInputAdapter`, `WebChatInputAdapter`, `TaskStore`, `HubEvent`
2. Replace `EventBus` import with `EventLog`
3. Replace `createApp` return type: remove `workflow`, `core`, change `eventBus` to `eventLog`, remove `store`
4. Remove all Core/RuleRouter/Executor/Registry initialization (lines 47-85)
5. Remove Input adapter creation
6. Simplify fault-healing section: just check env vars, set up `runAgent`, call `registerWebhookRoutes` with `{ db, eventLog, runFaultHealing }`
7. Pass `eventLog` instead of `eventBus`/`webChatAdapter` to `chatRouter`
8. Remove Lark callback route from startup log

**Step 5: Update sentry webhook test**

Update `test/webhooks/sentry.test.ts` to match the new simplified API.

**Step 6: Update notify test**

Update `test/lark/notify.test.ts` to test `buildNotificationCard` instead of `buildDiagnosisCard`/`buildPrReadyCard`.

**Step 7: Run all tests**

Run: `npx vitest run`
Expected: PASS

**Step 8: Commit**

```bash
git add -A
git commit -m "refactor: simplify server, webhooks, and Lark to agent autonomy model"
```

---

### Task 5: Clean up empty directories and verify

**Step 1: Remove empty directories**

```bash
rmdir src/tasks src/workflows src/adapters/input src/adapters/output src/adapters 2>/dev/null || true
rmdir test/tasks test/workflows test/adapters/input test/adapters/output test/adapters 2>/dev/null || true
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 3: Run TypeScript type-check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: clean up empty directories after orchestration removal"
```

---

### Summary

| Before | After |
|--------|-------|
| 12+ orchestration files | 0 |
| 9-state state machine | 3 statuses: running/done/failed |
| Two-phase workflow (analysis + fix) | Single agent run |
| Lark approval buttons + callbacks | Notification-only cards |
| EventBus (emit + dispatch) | EventLog (write-only) |
| Core → RuleRouter → Executor → SubAgent | Webhook → Agent Runner |
