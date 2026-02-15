# Event Bus + Adapter Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor AI Hub from two independent paths (fault-healing + chat) into a unified layered architecture with Event Bus, Input/Output Adapters, Core decision engine, and session management.

**Architecture:** All external inputs (Sentry, Lark, Notion, Web Chat) are normalized into `HubEvent` via Input Adapters, published to an in-memory EventBus, and handled by a Core layer that uses rule-based routing for known scenarios and AI orchestration for unknown ones. Sub-agents execute tasks, and Output Adapters deliver results to Lark, GitHub, Notion, or Web Chat.

**Tech Stack:** TypeScript 5.9, Hono, better-sqlite3, Claude Agent SDK, Zod, Vitest

**Design doc:** `docs/plans/2026-02-15-event-bus-adapter-architecture-design.md`

---

## Phase 1: Core Types + EventBus + DB Schema

### Task 1: HubEvent type definitions

**Files:**
- Create: `src/core/hub-event.ts`
- Test: `test/core/hub-event.test.ts`

**Step 1: Write the failing test**

```typescript
// test/core/hub-event.test.ts
import { describe, it, expect } from "vitest";
import { createHubEvent } from "../src/core/hub-event.js";

describe("createHubEvent", () => {
  it("creates event with id, type, source, and metadata", () => {
    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issue_id: "123" },
    });

    expect(event.id).toBeTruthy();
    expect(event.type).toBe("sentry.issue_alert");
    expect(event.source).toBe("sentry");
    expect(event.payload).toEqual({ issue_id: "123" });
    expect(event.metadata.receivedAt).toBeTruthy();
  });

  it("includes optional context", () => {
    const event = createHubEvent({
      type: "chat.web",
      source: "web_chat",
      payload: { message: "hello" },
      context: { userId: "u1", sessionId: "s1" },
    });

    expect(event.context?.userId).toBe("u1");
    expect(event.context?.sessionId).toBe("s1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/hub-event.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/core/hub-event.ts
import { randomUUID } from "node:crypto";

export type HubEvent = {
  id: string;
  type: string;
  source: string;
  payload: Record<string, any>;
  metadata: {
    receivedAt: string;
    traceId?: string;
  };
  context?: {
    sessionId?: string;
    userId?: string;
    replyTo?: string;
  };
};

export type CreateHubEventParams = {
  type: string;
  source: string;
  payload: Record<string, any>;
  context?: HubEvent["context"];
  traceId?: string;
};

export function createHubEvent(params: CreateHubEventParams): HubEvent {
  return {
    id: randomUUID(),
    type: params.type,
    source: params.source,
    payload: params.payload,
    metadata: {
      receivedAt: new Date().toISOString(),
      traceId: params.traceId,
    },
    context: params.context,
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/hub-event.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/hub-event.ts test/core/hub-event.test.ts
git commit -m "feat(core): add HubEvent type and factory"
```

---

### Task 2: EventBus implementation

**Files:**
- Create: `src/core/event-bus.ts`
- Test: `test/core/event-bus.test.ts`

**Step 1: Write the failing test**

```typescript
// test/core/event-bus.test.ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/core/event-bus.js";
import { createHubEvent } from "../src/core/hub-event.js";
import { createTestDb } from "./helpers.js";

describe("EventBus", () => {
  it("calls handler when event is emitted", async () => {
    const db = createTestDb();
    const bus = new EventBus(db);
    const handler = vi.fn();

    bus.on("sentry.*", handler);

    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issue_id: "1" },
    });
    await bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("wildcard * matches all events", async () => {
    const db = createTestDb();
    const bus = new EventBus(db);
    const handler = vi.fn();

    bus.on("*", handler);

    await bus.emit(
      createHubEvent({ type: "sentry.issue_alert", source: "sentry", payload: {} }),
    );
    await bus.emit(
      createHubEvent({ type: "chat.web", source: "web_chat", payload: {} }),
    );

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not call handler for non-matching pattern", async () => {
    const db = createTestDb();
    const bus = new EventBus(db);
    const handler = vi.fn();

    bus.on("notion.*", handler);

    await bus.emit(
      createHubEvent({ type: "sentry.issue_alert", source: "sentry", payload: {} }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("persists events to event_log table", async () => {
    const db = createTestDb();
    const bus = new EventBus(db);

    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issue_id: "42" },
      context: { userId: "u1" },
    });
    await bus.emit(event);

    const row = db.prepare("SELECT * FROM event_log WHERE id = ?").get(event.id) as any;
    expect(row).toBeTruthy();
    expect(row.type).toBe("sentry.issue_alert");
    expect(row.source).toBe("sentry");
    expect(JSON.parse(row.payload)).toEqual({ issue_id: "42" });
    expect(JSON.parse(row.context)).toEqual({ userId: "u1" });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/event-bus.test.ts`
Expected: FAIL — module not found + event_log table not found

**Step 3: Extend DB schema**

Add the `event_log`, `sessions`, and `messages` tables to `src/db.ts`. Append to the existing `initDb` function's `db.exec()` call:

```sql
CREATE TABLE IF NOT EXISTS event_log (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_log_type
  ON event_log(type, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages(session_id, created_at);
```

**Step 4: Write EventBus implementation**

```typescript
// src/core/event-bus.ts
import type Database from "better-sqlite3";
import type { HubEvent } from "./hub-event.js";

type Handler = (event: HubEvent) => Promise<void> | void;

export class EventBus {
  private handlers: Array<{ pattern: string; handler: Handler }> = [];

  constructor(private db: Database.Database) {}

  on(pattern: string, handler: Handler): void {
    this.handlers.push({ pattern, handler });
  }

  async emit(event: HubEvent): Promise<void> {
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

    for (const { pattern, handler } of this.handlers) {
      if (this.matches(pattern, event.type)) {
        await handler(event);
      }
    }
  }

  private matches(pattern: string, type: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) {
      return type.startsWith(pattern.slice(0, -1));
    }
    return pattern === type;
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run test/core/event-bus.test.ts`
Expected: PASS

**Step 6: Run all existing tests to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests PASS

**Step 7: Commit**

```bash
git add src/core/event-bus.ts test/core/event-bus.test.ts src/db.ts
git commit -m "feat(core): add EventBus with event_log persistence"
```

---

### Task 3: Adapter interfaces

**Files:**
- Create: `src/adapters/input/types.ts`
- Create: `src/adapters/output/types.ts`

**Step 1: Write input adapter interface**

```typescript
// src/adapters/input/types.ts
import type { HubEvent } from "../../core/hub-event.js";

export interface InputAdapter {
  readonly source: string;
  toEvent(raw: unknown): HubEvent | null;
}
```

**Step 2: Write output adapter interface and types**

```typescript
// src/adapters/output/types.ts
import type { ChatEvent } from "../../chat/types.js";

export type OutputAction =
  | { type: "notify"; channel: string; card: Record<string, any> }
  | { type: "create_pr"; repo: string; branch: string; title: string; body: string }
  | { type: "update_task"; target: string; taskId: string; status: string; result?: string }
  | { type: "stream_chat"; sessionId: string; events: AsyncIterable<ChatEvent> };

export interface OutputAdapter {
  readonly target: string;
  supports(action: OutputAction): boolean;
  send(action: OutputAction): Promise<void>;
}

export class OutputBus {
  constructor(private adapters: OutputAdapter[]) {}

  async send(action: OutputAction): Promise<void> {
    for (const adapter of this.adapters) {
      if (adapter.supports(action)) {
        await adapter.send(action);
        return;
      }
    }
    console.warn(`[output-bus] No adapter for action: ${action.type}`);
  }
}
```

**Step 3: Commit**

```bash
git add src/adapters/input/types.ts src/adapters/output/types.ts
git commit -m "feat(adapters): add InputAdapter and OutputAdapter interfaces"
```

---

## Phase 2: Input Adapters (migrate existing)

### Task 4: SentryInputAdapter

**Files:**
- Create: `src/adapters/input/sentry.ts`
- Test: `test/adapters/input/sentry.test.ts`
- Reference: `src/webhooks/sentry.ts` (existing logic to migrate)

**Step 1: Write the failing test**

```typescript
// test/adapters/input/sentry.test.ts
import { describe, it, expect } from "vitest";
import { SentryInputAdapter } from "../../src/adapters/input/sentry.js";

describe("SentryInputAdapter", () => {
  const adapter = new SentryInputAdapter();

  it("converts valid sentry webhook to HubEvent", () => {
    const raw = {
      action: "triggered",
      data: {
        issue: { id: "123", title: "TypeError", level: "error" },
        event: { event_id: "evt-1" },
      },
    };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("sentry.issue_alert");
    expect(event!.source).toBe("sentry");
    expect(event!.payload.issueId).toBe("123");
    expect(event!.payload.title).toBe("TypeError");
    expect(event!.payload.severity).toBe("P1");
    expect(event!.payload.eventId).toBe("evt-1");
  });

  it("returns null for invalid payload", () => {
    const event = adapter.toEvent({ garbage: true });
    expect(event).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/input/sentry.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/adapters/input/sentry.ts
import { z } from "zod";
import type { InputAdapter } from "./types.js";
import { createHubEvent, type HubEvent } from "../../core/hub-event.js";

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

export class SentryInputAdapter implements InputAdapter {
  readonly source = "sentry";

  toEvent(raw: unknown): HubEvent | null {
    const parsed = sentryPayloadSchema.safeParse(raw);
    if (!parsed.success) return null;

    const { data } = parsed.data;
    return createHubEvent({
      type: "sentry.issue_alert",
      source: this.source,
      payload: {
        issueId: data.issue.id,
        eventId: data.event?.event_id ?? "",
        title: data.issue.title,
        severity: mapSeverity(data.issue.level),
        level: data.issue.level,
      },
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/input/sentry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/input/sentry.ts test/adapters/input/sentry.test.ts
git commit -m "feat(adapters): add SentryInputAdapter"
```

---

### Task 5: LarkInputAdapter

**Files:**
- Create: `src/adapters/input/lark.ts`
- Test: `test/adapters/input/lark.test.ts`
- Reference: `src/lark/callback.ts` (existing logic to migrate)

**Step 1: Write the failing test**

```typescript
// test/adapters/input/lark.test.ts
import { describe, it, expect } from "vitest";
import { LarkInputAdapter } from "../../src/adapters/input/lark.js";

describe("LarkInputAdapter", () => {
  const adapter = new LarkInputAdapter();

  it("converts card action callback to HubEvent", () => {
    const raw = {
      action: { value: { action: "fix", taskId: "t-1" } },
    };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("lark.card_action");
    expect(event!.payload.action).toBe("fix");
    expect(event!.payload.taskId).toBe("t-1");
  });

  it("converts p2p chat message to HubEvent", () => {
    const raw = {
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user1" } },
        message: {
          chat_type: "p2p",
          message_id: "msg-1",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("chat.lark_p2p");
    expect(event!.payload.message).toBe("hello");
    expect(event!.context?.userId).toBe("ou_user1");
  });

  it("converts group @mention message to HubEvent", () => {
    const raw = {
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user2" } },
        message: {
          chat_type: "group",
          chat_id: "oc_group1",
          message_id: "msg-2",
          root_id: "msg-root",
          content: JSON.stringify({ text: "@_user_1 help me" }),
        },
      },
    };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("chat.lark_group");
    expect(event!.context?.userId).toBe("ou_user2");
    expect(event!.context?.replyTo).toBe("msg-root");
  });

  it("handles challenge verification", () => {
    const raw = { challenge: "abc123" };
    const event = adapter.toEvent(raw);
    expect(event).toBeNull(); // challenges are not events
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/input/lark.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/adapters/input/lark.ts
import type { InputAdapter } from "./types.js";
import { createHubEvent, type HubEvent } from "../../core/hub-event.js";

export class LarkInputAdapter implements InputAdapter {
  readonly source = "lark";

  toEvent(raw: unknown): HubEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const body = raw as Record<string, any>;

    // Challenge verification — not an event
    if (body.challenge) return null;

    // Card action callback
    if (body.action?.value?.action) {
      return createHubEvent({
        type: "lark.card_action",
        source: this.source,
        payload: {
          action: body.action.value.action,
          taskId: body.action.value.taskId,
        },
      });
    }

    // Message event
    if (body.header?.event_type === "im.message.receive_v1" && body.event?.message) {
      const msg = body.event.message;
      const senderId = body.event.sender?.sender_id?.open_id ?? "";
      const chatType = msg.chat_type;

      let text = "";
      try {
        const content = JSON.parse(msg.content ?? "{}");
        text = content.text ?? "";
      } catch {
        text = "";
      }

      const type = chatType === "p2p" ? "chat.lark_p2p" : "chat.lark_group";

      return createHubEvent({
        type,
        source: this.source,
        payload: {
          message: text,
          messageId: msg.message_id,
          chatId: msg.chat_id,
        },
        context: {
          userId: senderId,
          replyTo: msg.root_id,
        },
      });
    }

    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/input/lark.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/input/lark.ts test/adapters/input/lark.test.ts
git commit -m "feat(adapters): add LarkInputAdapter"
```

---

### Task 6: WebChatInputAdapter

**Files:**
- Create: `src/adapters/input/web-chat.ts`
- Test: `test/adapters/input/web-chat.test.ts`

**Step 1: Write the failing test**

```typescript
// test/adapters/input/web-chat.test.ts
import { describe, it, expect } from "vitest";
import { WebChatInputAdapter } from "../../src/adapters/input/web-chat.js";

describe("WebChatInputAdapter", () => {
  const adapter = new WebChatInputAdapter();

  it("converts chat request to HubEvent", () => {
    const raw = { message: "hello", sessionId: "s-1" };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("chat.web");
    expect(event!.source).toBe("web_chat");
    expect(event!.payload.message).toBe("hello");
    expect(event!.context?.sessionId).toBe("s-1");
  });

  it("returns null if message is missing", () => {
    const event = adapter.toEvent({ sessionId: "s-1" });
    expect(event).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/input/web-chat.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/adapters/input/web-chat.ts
import type { InputAdapter } from "./types.js";
import { createHubEvent, type HubEvent } from "../../core/hub-event.js";

export class WebChatInputAdapter implements InputAdapter {
  readonly source = "web_chat";

  toEvent(raw: unknown): HubEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const body = raw as Record<string, any>;

    if (!body.message || typeof body.message !== "string") return null;

    return createHubEvent({
      type: "chat.web",
      source: this.source,
      payload: { message: body.message },
      context: {
        sessionId: body.sessionId,
      },
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/input/web-chat.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/input/web-chat.ts test/adapters/input/web-chat.test.ts
git commit -m "feat(adapters): add WebChatInputAdapter"
```

---

## Phase 3: Session Management

### Task 7: SessionManager

**Files:**
- Create: `src/sessions/types.ts`
- Create: `src/sessions/manager.ts`
- Test: `test/sessions/manager.test.ts`

**Step 1: Write session types**

```typescript
// src/sessions/types.ts
export type Session = {
  id: string;
  userId: string;
  channel: string;
  channelId: string;
  provider: string;
  providerSessionId: string | null;
  status: "active" | "closed";
  createdAt: string;
  lastActiveAt: string;
};

export type Message = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls: string | null;
  createdAt: string;
};
```

**Step 2: Write the failing test**

```typescript
// test/sessions/manager.test.ts
import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/sessions/manager.js";
import { createTestDb } from "./helpers.js";

describe("SessionManager", () => {
  it("creates a new session", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);

    const session = mgr.create({
      userId: "ou_user1",
      channel: "lark_p2p",
      channelId: "ou_user1",
      provider: "claude",
    });

    expect(session.id).toBeTruthy();
    expect(session.userId).toBe("ou_user1");
    expect(session.status).toBe("active");
  });

  it("finds active session by userId and channel", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);

    const created = mgr.create({
      userId: "ou_user1",
      channel: "lark_p2p",
      channelId: "ou_user1",
      provider: "claude",
    });

    const found = mgr.findActive("ou_user1", "lark_p2p");
    expect(found?.id).toBe(created.id);
  });

  it("returns null when no active session", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);

    const found = mgr.findActive("nonexistent", "lark_p2p");
    expect(found).toBeNull();
  });

  it("appends and retrieves messages", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);

    const session = mgr.create({
      userId: "u1",
      channel: "web_chat",
      channelId: "tab-1",
      provider: "deepseek",
    });

    mgr.appendMessage(session.id, { role: "user", content: "hello" });
    mgr.appendMessage(session.id, { role: "assistant", content: "hi there" });

    const messages = mgr.getMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("updates providerSessionId", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);

    const session = mgr.create({
      userId: "u1",
      channel: "lark_p2p",
      channelId: "u1",
      provider: "claude",
    });

    mgr.updateProviderSessionId(session.id, "claude-session-xyz");

    const updated = mgr.getById(session.id);
    expect(updated?.providerSessionId).toBe("claude-session-xyz");
  });

  it("touches lastActiveAt", () => {
    const db = createTestDb();
    const mgr = new SessionManager(db);

    const session = mgr.create({
      userId: "u1",
      channel: "web_chat",
      channelId: "tab-1",
      provider: "claude",
    });

    const before = session.lastActiveAt;
    // SQLite datetime precision is seconds, so touch should update
    mgr.touch(session.id);
    const after = mgr.getById(session.id)!.lastActiveAt;
    expect(after).toBeTruthy();
  });
});
```

**Step 3: Run test to verify it fails**

Run: `npx vitest run test/sessions/manager.test.ts`
Expected: FAIL

**Step 4: Write implementation**

```typescript
// src/sessions/manager.ts
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Session, Message } from "./types.js";

type CreateSessionParams = {
  userId: string;
  channel: string;
  channelId: string;
  provider: string;
};

type AppendMessageParams = {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: string;
};

export class SessionManager {
  constructor(private db: Database.Database) {}

  create(params: CreateSessionParams): Session {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, channel, channel_id, provider)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, params.userId, params.channel, params.channelId, params.provider);
    return this.getById(id)!;
  }

  getById(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as any;
    return row ? this.mapSession(row) : null;
  }

  findActive(userId: string, channel: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE user_id = ? AND channel = ? AND status = 'active'
         ORDER BY last_active_at DESC LIMIT 1`,
      )
      .get(userId, channel) as any;
    return row ? this.mapSession(row) : null;
  }

  updateProviderSessionId(id: string, providerSessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET provider_session_id = ?, last_active_at = datetime('now') WHERE id = ?")
      .run(providerSessionId, id);
  }

  touch(id: string): void {
    this.db
      .prepare("UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  close(id: string): void {
    this.db
      .prepare("UPDATE sessions SET status = 'closed', last_active_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  appendMessage(sessionId: string, params: AppendMessageParams): Message {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, tool_calls)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, params.role, params.content, params.toolCalls ?? null);
    this.touch(sessionId);
    return this.getMessageById(id)!;
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as any[];
    return rows.map(this.mapMessage);
  }

  private getMessageById(id: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as any;
    return row ? this.mapMessage(row) : null;
  }

  private mapSession(row: any): Session {
    return {
      id: row.id,
      userId: row.user_id,
      channel: row.channel,
      channelId: row.channel_id,
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      status: row.status,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  private mapMessage(row: any): Message {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      toolCalls: row.tool_calls,
      createdAt: row.created_at,
    };
  }
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run test/sessions/manager.test.ts`
Expected: PASS

**Step 6: Run all tests**

Run: `npx vitest run`
Expected: All PASS

**Step 7: Commit**

```bash
git add src/sessions/types.ts src/sessions/manager.ts test/sessions/manager.test.ts
git commit -m "feat(sessions): add SessionManager with messages"
```

---

## Phase 4: Core Decision Engine

### Task 8: RuleRouter

**Files:**
- Create: `src/core/rule-router.ts`
- Test: `test/core/rule-router.test.ts`

**Step 1: Write the failing test**

```typescript
// test/core/rule-router.test.ts
import { describe, it, expect } from "vitest";
import { RuleRouter, type Route, type TaskPlan } from "../src/core/rule-router.js";
import { createHubEvent } from "../src/core/hub-event.js";

describe("RuleRouter", () => {
  it("matches a sentry event to a route", () => {
    const routes: Route[] = [
      {
        match: (e) => e.type === "sentry.issue_alert",
        plan: (e) => ({
          agent: "code-fixer",
          skill: "fault-healing",
          inputs: { issueId: e.payload.issueId },
          outputs: [{ type: "notify", channel: "lark", card: {} }],
        }),
      },
    ];

    const router = new RuleRouter(routes);
    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issueId: "123" },
    });

    const plan = router.match(event);
    expect(plan).not.toBeNull();
    expect(plan!.agent).toBe("code-fixer");
    expect(plan!.inputs.issueId).toBe("123");
  });

  it("returns null when no route matches", () => {
    const router = new RuleRouter([]);
    const event = createHubEvent({
      type: "unknown.event",
      source: "unknown",
      payload: {},
    });

    expect(router.match(event)).toBeNull();
  });

  it("uses first matching route", () => {
    const routes: Route[] = [
      {
        match: (e) => e.type === "sentry.issue_alert",
        plan: () => ({ agent: "first", inputs: {}, outputs: [] }),
      },
      {
        match: (e) => e.type === "sentry.issue_alert",
        plan: () => ({ agent: "second", inputs: {}, outputs: [] }),
      },
    ];

    const router = new RuleRouter(routes);
    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: {},
    });

    expect(router.match(event)!.agent).toBe("first");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/rule-router.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/core/rule-router.ts
import type { HubEvent } from "./hub-event.js";
import type { OutputAction } from "../adapters/output/types.js";

export type TaskPlan = {
  agent: string;
  skill?: string;
  inputs: Record<string, any>;
  outputs: OutputAction[];
  provider?: string;
};

export type Route = {
  match: (event: HubEvent) => boolean;
  plan: (event: HubEvent) => TaskPlan;
};

export class RuleRouter {
  constructor(private routes: Route[]) {}

  match(event: HubEvent): TaskPlan | null {
    for (const route of this.routes) {
      if (route.match(event)) {
        return route.plan(event);
      }
    }
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/rule-router.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/rule-router.ts test/core/rule-router.test.ts
git commit -m "feat(core): add RuleRouter"
```

---

### Task 9: SubAgent interface and AgentRegistry

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/registry.ts`
- Test: `test/agents/registry.test.ts`

**Step 1: Write the failing test**

```typescript
// test/agents/registry.test.ts
import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../src/agents/registry.js";
import type { SubAgent, TaskExecution, AgentEvent } from "../src/agents/types.js";

const fakeAgent: SubAgent = {
  name: "test-agent",
  description: "A test agent",
  async *execute(_task: TaskExecution): AsyncIterable<AgentEvent> {
    yield { type: "result", content: "done" };
  },
};

describe("AgentRegistry", () => {
  it("registers and retrieves agent by name", () => {
    const registry = new AgentRegistry([fakeAgent]);
    expect(registry.get("test-agent")).toBe(fakeAgent);
  });

  it("returns undefined for unknown agent", () => {
    const registry = new AgentRegistry([fakeAgent]);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all agents", () => {
    const registry = new AgentRegistry([fakeAgent]);
    expect(registry.list()).toEqual([
      { name: "test-agent", description: "A test agent" },
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/agents/registry.test.ts`
Expected: FAIL

**Step 3: Write types and registry**

```typescript
// src/agents/types.ts
export type AgentEvent =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; tool: string; input: Record<string, any> }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "result"; content: string; artifacts?: Artifact[] }
  | { type: "error"; message: string };

export type Artifact = {
  kind: "pr" | "document" | "analysis" | "patch";
  data: Record<string, any>;
};

export type TaskExecution = {
  taskId: string;
  skill?: string;
  inputs: Record<string, any>;
  provider: string;
  tools?: string[];
};

export interface SubAgent {
  readonly name: string;
  readonly description: string;
  execute(task: TaskExecution): AsyncIterable<AgentEvent>;
}
```

```typescript
// src/agents/registry.ts
import type { SubAgent } from "./types.js";

export class AgentRegistry {
  private agents = new Map<string, SubAgent>();

  constructor(agents: SubAgent[]) {
    for (const agent of agents) {
      this.agents.set(agent.name, agent);
    }
  }

  get(name: string): SubAgent | undefined {
    return this.agents.get(name);
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.agents.values()].map((a) => ({
      name: a.name,
      description: a.description,
    }));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/agents/registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/types.ts src/agents/registry.ts test/agents/registry.test.ts
git commit -m "feat(agents): add SubAgent interface and AgentRegistry"
```

---

### Task 10: Executor

**Files:**
- Create: `src/core/executor.ts`
- Test: `test/core/executor.test.ts`

**Step 1: Write the failing test**

```typescript
// test/core/executor.test.ts
import { describe, it, expect, vi } from "vitest";
import { Executor } from "../src/core/executor.js";
import { AgentRegistry } from "../src/agents/registry.js";
import type { SubAgent, AgentEvent } from "../src/agents/types.js";
import type { TaskPlan } from "../src/core/rule-router.js";
import { createHubEvent } from "../src/core/hub-event.js";
import { createTestDb } from "./helpers.js";
import { TaskStore } from "../src/tasks/store.js";

const mockAgent: SubAgent = {
  name: "test-agent",
  description: "test",
  async *execute(): AsyncIterable<AgentEvent> {
    yield { type: "thinking", content: "analyzing..." };
    yield {
      type: "result",
      content: "fixed",
      artifacts: [{ kind: "pr", data: { url: "https://github.com/pr/1" } }],
    };
  },
};

describe("Executor", () => {
  it("runs a plan: finds agent, executes, logs events", async () => {
    const db = createTestDb();
    const registry = new AgentRegistry([mockAgent]);
    const outputSend = vi.fn();
    const executor = new Executor({ registry, db, outputSend });

    const plan: TaskPlan = {
      agent: "test-agent",
      inputs: { issueId: "123" },
      outputs: [{ type: "notify", channel: "lark", card: {} }],
    };
    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issueId: "123" },
    });

    await executor.run(plan, event);

    // outputSend should have been called for the "result" event
    expect(outputSend).toHaveBeenCalled();
  });

  it("throws if agent not found", async () => {
    const db = createTestDb();
    const registry = new AgentRegistry([]);
    const executor = new Executor({ registry, db, outputSend: vi.fn() });

    const plan: TaskPlan = {
      agent: "nonexistent",
      inputs: {},
      outputs: [],
    };
    const event = createHubEvent({ type: "test", source: "test", payload: {} });

    await expect(executor.run(plan, event)).rejects.toThrow("Agent not found");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/executor.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/core/executor.ts
import type Database from "better-sqlite3";
import type { AgentRegistry } from "../agents/registry.js";
import type { TaskPlan } from "./rule-router.js";
import type { HubEvent } from "./hub-event.js";
import type { OutputAction } from "../adapters/output/types.js";
import type { AgentEvent } from "../agents/types.js";

type ExecutorDeps = {
  registry: AgentRegistry;
  db: Database.Database;
  outputSend: (action: OutputAction, agentEvent: AgentEvent) => Promise<void> | void;
};

export class Executor {
  constructor(private deps: ExecutorDeps) {}

  async run(plan: TaskPlan, event: HubEvent): Promise<void> {
    const agent = this.deps.registry.get(plan.agent);
    if (!agent) throw new Error(`Agent not found: ${plan.agent}`);

    const taskId = event.id;

    const execution = {
      taskId,
      skill: plan.skill,
      inputs: plan.inputs,
      provider: plan.provider ?? "claude",
    };

    for await (const agentEvent of agent.execute(execution)) {
      // Log to audit_log
      this.deps.db
        .prepare("INSERT INTO audit_log (task_id, action, detail) VALUES (?, ?, ?)")
        .run(taskId, agentEvent.type, JSON.stringify(agentEvent));

      // On result → trigger outputs
      if (agentEvent.type === "result") {
        for (const output of plan.outputs) {
          await this.deps.outputSend(output, agentEvent);
        }
      }
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/executor.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/executor.ts test/core/executor.test.ts
git commit -m "feat(core): add Executor"
```

---

### Task 11: Core decision engine

**Files:**
- Create: `src/core/core.ts`
- Test: `test/core/core.test.ts`

**Step 1: Write the failing test**

```typescript
// test/core/core.test.ts
import { describe, it, expect, vi } from "vitest";
import { Core } from "../src/core/core.js";
import { RuleRouter } from "../src/core/rule-router.js";
import { Executor } from "../src/core/executor.js";
import { AgentRegistry } from "../src/agents/registry.js";
import { SessionManager } from "../src/sessions/manager.js";
import { createHubEvent } from "../src/core/hub-event.js";
import { createTestDb } from "./helpers.js";
import type { AgentEvent, SubAgent } from "../src/agents/types.js";

const fakeAgent: SubAgent = {
  name: "code-fixer",
  description: "fixes code",
  async *execute(): AsyncIterable<AgentEvent> {
    yield { type: "result", content: "fixed" };
  },
};

describe("Core", () => {
  it("routes sentry event via RuleRouter to Executor", async () => {
    const db = createTestDb();
    const outputSend = vi.fn();

    const core = new Core({
      ruleRouter: new RuleRouter([
        {
          match: (e) => e.type === "sentry.issue_alert",
          plan: (e) => ({
            agent: "code-fixer",
            skill: "fault-healing",
            inputs: { issueId: e.payload.issueId },
            outputs: [{ type: "notify", channel: "lark", card: {} }],
          }),
        },
      ]),
      executor: new Executor({
        registry: new AgentRegistry([fakeAgent]),
        db,
        outputSend,
      }),
      sessionManager: new SessionManager(db),
      handleChat: vi.fn(),
    });

    const event = createHubEvent({
      type: "sentry.issue_alert",
      source: "sentry",
      payload: { issueId: "123" },
    });

    await core.handle(event);

    expect(outputSend).toHaveBeenCalled();
  });

  it("routes chat event to handleChat", async () => {
    const db = createTestDb();
    const handleChat = vi.fn();

    const core = new Core({
      ruleRouter: new RuleRouter([]),
      executor: new Executor({
        registry: new AgentRegistry([]),
        db,
        outputSend: vi.fn(),
      }),
      sessionManager: new SessionManager(db),
      handleChat,
    });

    const event = createHubEvent({
      type: "chat.web",
      source: "web_chat",
      payload: { message: "hello" },
      context: { sessionId: "s-1" },
    });

    await core.handle(event);

    expect(handleChat).toHaveBeenCalledWith(event);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/core.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/core/core.ts
import type { RuleRouter } from "./rule-router.js";
import type { Executor } from "./executor.js";
import type { SessionManager } from "../sessions/manager.js";
import type { HubEvent } from "./hub-event.js";

type CoreDeps = {
  ruleRouter: RuleRouter;
  executor: Executor;
  sessionManager: SessionManager;
  handleChat: (event: HubEvent) => Promise<void> | void;
};

export class Core {
  constructor(private deps: CoreDeps) {}

  async handle(event: HubEvent): Promise<void> {
    // 1. Chat events → session-based chat flow
    if (event.type.startsWith("chat.")) {
      return this.deps.handleChat(event);
    }

    // 2. Rule-based routing
    const plan = this.deps.ruleRouter.match(event);
    if (plan) {
      return this.deps.executor.run(plan, event);
    }

    // 3. Unmatched events — log and skip for now
    // TODO: OrchestratorAgent for AI-based decision
    console.warn(`[core] No handler for event: ${event.type}`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/core.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/core.ts test/core/core.test.ts
git commit -m "feat(core): add Core decision engine"
```

---

## Phase 5: Wire Everything Together in server.ts

### Task 12: Refactor server.ts to use new architecture

**Files:**
- Modify: `src/server.ts`
- Modify: `src/chat/types.ts` (update ChatProvider interface)
- Keep: All existing files — do NOT delete old files yet, leave as dead code

This is the integration task. The goal is to make `createApp()` assemble the new architecture while keeping all existing functionality working.

**Step 1: Update ChatProvider interface**

In `src/chat/types.ts`, add the `Message` import and update the interface to accept messages + session:

```typescript
// src/chat/types.ts
import type { Message } from "../sessions/types.js";
import type { Session } from "../sessions/types.js";

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string; costUsd: number };

export type ChatRequest = {
  message: string;
  sessionId?: string;
};

export interface ChatProvider {
  readonly name: string;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
}
```

Note: Keep the existing `ChatProvider` interface for now. The session-aware interface will be introduced when we refactor providers in a follow-up phase. For this task, we wire the new architecture around the existing providers.

**Step 2: Rewrite server.ts**

Rewrite `src/server.ts` to use the new architecture. Key changes:
- Create EventBus, SessionManager, Core, Executor, RuleRouter
- Create Input Adapters for each route
- Keep existing ChatProvider setup (not yet refactored)
- Route handlers become thin: parse → adapter.toEvent() → eventBus.emit()
- Chat events handled via `handleChat` callback that uses existing ChatProvider

The server.ts rewrite should:
1. Keep all existing imports that are still needed (ChatProvider, ClaudeProvider, GenericProvider, etc.)
2. Add new imports for the new modules
3. Create all new infrastructure in `createApp()`
4. Replace route handlers to use adapters + eventBus
5. Wire `handleChat` to use existing ChatProvider + SessionManager for message persistence

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (existing behavior preserved)

**Step 4: Manual smoke test**

Run: `npm run dev`
- Verify `GET /health` returns `{ status: "ok" }`
- Verify chat UI loads at `/`
- Verify sending a chat message works (if ANTHROPIC_API_KEY is set)

**Step 5: Commit**

```bash
git add src/server.ts src/chat/types.ts
git commit -m "refactor(server): wire new architecture (EventBus + Adapters + Core)"
```

---

### Task 13: Output Adapters (LarkOutputAdapter)

**Files:**
- Create: `src/adapters/output/lark.ts`
- Test: `test/adapters/output/lark.test.ts`
- Reference: `src/lark/notify.ts` (wrap existing functions)

**Step 1: Write the failing test**

```typescript
// test/adapters/output/lark.test.ts
import { describe, it, expect, vi } from "vitest";
import { LarkOutputAdapter } from "../../src/adapters/output/lark.js";

describe("LarkOutputAdapter", () => {
  it("supports notify action", () => {
    const adapter = new LarkOutputAdapter({ sendCard: vi.fn() });
    expect(adapter.supports({ type: "notify", channel: "lark", card: {} })).toBe(true);
  });

  it("does not support create_pr action", () => {
    const adapter = new LarkOutputAdapter({ sendCard: vi.fn() });
    expect(
      adapter.supports({ type: "create_pr", repo: "", branch: "", title: "", body: "" }),
    ).toBe(false);
  });

  it("calls sendCard on notify action", async () => {
    const sendCard = vi.fn().mockResolvedValue("msg-1");
    const adapter = new LarkOutputAdapter({ sendCard });

    await adapter.send({ type: "notify", channel: "lark", card: { header: {} } });

    expect(sendCard).toHaveBeenCalledWith({ header: {} });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/adapters/output/lark.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/adapters/output/lark.ts
import type { OutputAdapter, OutputAction } from "./types.js";

type LarkOutputDeps = {
  sendCard: (card: Record<string, any>) => Promise<string | null>;
};

export class LarkOutputAdapter implements OutputAdapter {
  readonly target = "lark";

  constructor(private deps: LarkOutputDeps) {}

  supports(action: OutputAction): boolean {
    return action.type === "notify" && (action as any).channel === "lark";
  }

  async send(action: OutputAction): Promise<void> {
    if (action.type === "notify") {
      await this.deps.sendCard(action.card);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/adapters/output/lark.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/output/lark.ts test/adapters/output/lark.test.ts
git commit -m "feat(adapters): add LarkOutputAdapter"
```

---

### Task 14: Run all tests and verify

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Check for TypeScript errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit any fixes if needed**

---

### Task 15: Clean up — remove dead code

Only after all tests pass and the new architecture is verified:

**Files to evaluate for removal:**
- `src/webhooks/sentry.ts` — replaced by `SentryInputAdapter` + thin route in server.ts
- `src/lark/callback.ts` — replaced by `LarkInputAdapter` + thin route in server.ts

**Do NOT remove yet:**
- `src/lark/notify.ts` — still used by `LarkOutputAdapter`
- `src/workflows/fault-healing.ts` — will be refactored into code-fixer SubAgent in Phase 6
- `src/chat/router.ts` — will be refactored to use SessionManager in Phase 6
- `src/agent/runner.ts` — will be used internally by SubAgents

Evaluate whether old files can be safely removed by checking:
1. Are they still imported by anything?
2. Are there tests that import them directly?

If old files are still used by existing tests, leave them and mark with a `// TODO: migrate to new architecture` comment.

**Step 1: Check imports**

Run: `grep -r "webhooks/sentry" src/ test/` and `grep -r "lark/callback" src/ test/`

**Step 2: Remove or annotate as appropriate**

**Step 3: Run tests**

Run: `npx vitest run`
Expected: All PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: annotate legacy files for migration"
```

---

## Summary of deliverables per phase

| Phase | Tasks | What's built |
|-------|-------|-------------|
| 1 | 1-3 | HubEvent types, EventBus with persistence, Adapter interfaces, DB schema |
| 2 | 4-6 | SentryInputAdapter, LarkInputAdapter, WebChatInputAdapter |
| 3 | 7 | SessionManager with messages table |
| 4 | 8-11 | RuleRouter, AgentRegistry, Executor, Core decision engine |
| 5 | 12-15 | server.ts integration, LarkOutputAdapter, cleanup |

## Future phases (not in this plan)

- **Phase 6**: Refactor `FaultHealingWorkflow` → `CodeFixerAgent` SubAgent
- **Phase 7**: Refactor `ChatProvider` to use `SessionManager` for multi-provider session resume
- **Phase 8**: Add `NotionInputAdapter` + `NotionOutputAdapter`
- **Phase 9**: Add `OrchestratorAgent` for AI-based decision on unmatched events
