# Nanobot-Inspired Architecture Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor AI Claw to add Provider Registry, Channel abstraction with event-based MessageBus, and Subagent/Spawn background task execution.

**Architecture:** Three-phase refactor following dependency order: (1) Provider Registry — registry pattern replacing if-else factory, supporting multiple OpenAI-compatible endpoints via `PROVIDER_{NAME}_*` env vars; (2) Channel abstraction — `Channel` interface + `ChannelManager` wrapping Web SSE and Lark webhook into pluggable channels; (3) Subagent/Spawn — `SubagentManager` executing background tasks via the registry, reporting results as system messages to the parent session.

**Tech Stack:** TypeScript 5.9, Hono, Vitest, Zod, better-sqlite3, Claude Agent SDK

**Design doc:** `docs/plans/2026-02-26-nanobot-inspired-refactor-design.md`

---

## Phase 1: Provider Registry

### Task 1: ProviderRegistry core class

**Files:**
- Create: `src/chat/provider-registry.ts`
- Test: `test/chat/provider-registry.test.ts`

**Step 1: Write the failing test**

```typescript
// test/chat/provider-registry.test.ts
import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../../src/chat/provider-registry.js";
import type { ChatProvider } from "../../src/chat/types.js";

function fakeProvider(name: string): ChatProvider {
  return {
    name,
    async *stream() {
      yield { type: "text" as const, content: "hi" };
      yield { type: "done" as const, sessionId: "", costUsd: 0 };
    },
  };
}

describe("ProviderRegistry", () => {
  it("registers and creates a provider", () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => fakeProvider("test"),
    });

    const provider = registry.create("test");
    expect(provider.name).toBe("test");
  });

  it("throws on unknown provider name", () => {
    const registry = new ProviderRegistry();
    expect(() => registry.create("nope")).toThrow(/not registered/i);
  });

  it("lists all registered specs", () => {
    const registry = new ProviderRegistry();
    registry.register({ name: "a", type: "claude", factory: () => fakeProvider("a") });
    registry.register({ name: "b", type: "openai-compatible", factory: () => fakeProvider("b") });
    expect(registry.list().map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("has() returns true for registered, false for unknown", () => {
    const registry = new ProviderRegistry();
    registry.register({ name: "x", type: "claude", factory: () => fakeProvider("x") });
    expect(registry.has("x")).toBe(true);
    expect(registry.has("y")).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/provider-registry.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/chat/provider-registry.ts
import type { ChatProvider } from "./types.js";

export type ProviderFactory = (opts?: Record<string, unknown>) => ChatProvider;

export type ProviderSpec = {
  name: string;
  type: "claude" | "openai-compatible";
  factory: ProviderFactory;
};

export class ProviderRegistry {
  private specs = new Map<string, ProviderSpec>();

  register(spec: ProviderSpec): void {
    this.specs.set(spec.name, spec);
  }

  create(name: string, opts?: Record<string, unknown>): ChatProvider {
    const spec = this.specs.get(name);
    if (!spec) {
      throw new Error(
        `Provider "${name}" not registered. Available: ${[...this.specs.keys()].join(", ")}`,
      );
    }
    return spec.factory(opts);
  }

  has(name: string): boolean {
    return this.specs.has(name);
  }

  list(): ProviderSpec[] {
    return [...this.specs.values()];
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat/provider-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/chat/provider-registry.ts test/chat/provider-registry.test.ts
git commit -m "feat: add ProviderRegistry core class"
```

---

### Task 2: Auto-discovery of PROVIDER_{NAME}_* env vars

**Files:**
- Modify: `src/chat/provider-registry.ts`
- Modify: `test/chat/provider-registry.test.ts`

**Step 1: Write the failing test**

Append to `test/chat/provider-registry.test.ts`:

```typescript
import { scanProviderEnvVars } from "../../src/chat/provider-registry.js";

describe("scanProviderEnvVars", () => {
  it("extracts provider configs from PROVIDER_{NAME}_* env vars", () => {
    const env: Record<string, string | undefined> = {
      PROVIDER_DEEPSEEK_API_BASE: "https://api.deepseek.com",
      PROVIDER_DEEPSEEK_API_KEY: "sk-deep",
      PROVIDER_DEEPSEEK_MODEL: "deepseek-chat",
      PROVIDER_QWEN_API_BASE: "https://qwen.api",
      PROVIDER_QWEN_API_KEY: "sk-qwen",
      OTHER_VAR: "ignored",
    };

    const configs = scanProviderEnvVars(env);
    expect(configs).toHaveLength(2);

    const ds = configs.find((c) => c.name === "deepseek");
    expect(ds).toMatchObject({
      name: "deepseek",
      apiBase: "https://api.deepseek.com",
      apiKey: "sk-deep",
      model: "deepseek-chat",
    });

    const qw = configs.find((c) => c.name === "qwen");
    expect(qw).toMatchObject({
      name: "qwen",
      apiBase: "https://qwen.api",
      apiKey: "sk-qwen",
    });
    // model defaults to undefined if not set
    expect(qw!.model).toBeUndefined();
  });

  it("skips providers missing API_BASE or API_KEY", () => {
    const env = {
      PROVIDER_INCOMPLETE_API_BASE: "https://example.com",
      // missing API_KEY — should be skipped
    };
    const configs = scanProviderEnvVars(env);
    expect(configs).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/provider-registry.test.ts`
Expected: FAIL — `scanProviderEnvVars` not exported

**Step 3: Write implementation**

Add to `src/chat/provider-registry.ts`:

```typescript
export type ProviderEnvConfig = {
  name: string;
  apiBase: string;
  apiKey: string;
  model?: string;
  maxToolResultChars?: number;
  maxContextTokens?: number;
  fetchTimeout?: number;
};

/**
 * Scan env vars for PROVIDER_{NAME}_API_BASE + PROVIDER_{NAME}_API_KEY pairs.
 * Returns configs for all providers that have both required vars.
 */
export function scanProviderEnvVars(
  env: Record<string, string | undefined>,
): ProviderEnvConfig[] {
  const providers = new Map<string, Partial<ProviderEnvConfig>>();
  const prefix = "PROVIDER_";

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || !value) continue;

    const rest = key.slice(prefix.length);
    const underscoreIdx = rest.indexOf("_");
    if (underscoreIdx < 0) continue;

    const name = rest.slice(0, underscoreIdx).toLowerCase();
    const field = rest.slice(underscoreIdx + 1);

    if (!providers.has(name)) providers.set(name, { name });
    const config = providers.get(name)!;

    switch (field) {
      case "API_BASE":
        config.apiBase = value;
        break;
      case "API_KEY":
        config.apiKey = value;
        break;
      case "MODEL":
        config.model = value;
        break;
      case "MAX_TOOL_RESULT_CHARS":
        config.maxToolResultChars = Number(value);
        break;
      case "MAX_CONTEXT_TOKENS":
        config.maxContextTokens = Number(value);
        break;
      case "FETCH_TIMEOUT":
        config.fetchTimeout = Number(value);
        break;
    }
  }

  return [...providers.values()].filter(
    (c): c is ProviderEnvConfig => !!c.apiBase && !!c.apiKey,
  );
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat/provider-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/chat/provider-registry.ts test/chat/provider-registry.test.ts
git commit -m "feat: add PROVIDER_{NAME}_* env var auto-discovery"
```

---

### Task 3: buildDefaultRegistry() and refactor setup.ts

**Files:**
- Modify: `src/chat/provider-registry.ts` (add `buildDefaultRegistry`)
- Modify: `src/chat/setup.ts` (use registry)
- Modify: `src/env.ts` (change CHAT_PROVIDER to accept any string)
- Modify: `test/chat/provider-registry.test.ts` (test buildDefaultRegistry)

**Step 1: Write the failing test**

Append to `test/chat/provider-registry.test.ts`:

```typescript
import { buildDefaultRegistry } from "../../src/chat/provider-registry.js";

describe("buildDefaultRegistry", () => {
  it("always registers claude when ANTHROPIC_API_KEY is set", () => {
    const registry = buildDefaultRegistry({
      ANTHROPIC_API_KEY: "sk-ant-test",
      WORKSPACE_DIR: "/tmp",
    }, { systemPrompt: "", skillsDirs: [], mcpServers: {} });

    expect(registry.has("claude")).toBe(true);
  });

  it("registers providers from PROVIDER_* env vars", () => {
    const registry = buildDefaultRegistry({
      WORKSPACE_DIR: "/tmp",
      PROVIDER_DEEPSEEK_API_BASE: "https://api.deepseek.com",
      PROVIDER_DEEPSEEK_API_KEY: "sk-deep",
      PROVIDER_DEEPSEEK_MODEL: "deepseek-chat",
    }, { systemPrompt: "test", skillsDirs: [], mcpServers: {} });

    expect(registry.has("deepseek")).toBe(true);
  });

  it("registers 'generic' provider from legacy CHAT_API_BASE/KEY", () => {
    const registry = buildDefaultRegistry({
      WORKSPACE_DIR: "/tmp",
      CHAT_API_BASE: "https://api.deepseek.com",
      CHAT_API_KEY: "sk-legacy",
      CHAT_MODEL: "deepseek-chat",
    }, { systemPrompt: "test", skillsDirs: [], mcpServers: {} });

    expect(registry.has("generic")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/provider-registry.test.ts`
Expected: FAIL — `buildDefaultRegistry` not exported

**Step 3: Write implementation**

Add `buildDefaultRegistry` to `src/chat/provider-registry.ts`. It should:
1. Always register `claude` (lazy — fails at create time if no API key)
2. Scan `PROVIDER_{NAME}_*` env vars, register each as GenericProvider factory
3. For backwards compat, if `CHAT_API_BASE` + `CHAT_API_KEY` exist, register as `generic`

Then **refactor `src/chat/setup.ts`** to:
1. Call `buildDefaultRegistry(env, { systemPrompt, skillsDirs, mcpServers })`
2. Call `registry.create(env.CHAT_PROVIDER ?? "claude")` to get the provider
3. Export `registry` alongside `provider` so Subagent can use it later

Also **update `src/env.ts`**: change `CHAT_PROVIDER` from `z.enum(["claude", "generic"])` to `z.string().default("claude")` to allow any registered provider name.

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS — existing behavior preserved via backwards-compatible `generic` registration

**Step 5: Commit**

```bash
git add src/chat/provider-registry.ts src/chat/setup.ts src/env.ts test/chat/provider-registry.test.ts
git commit -m "feat: buildDefaultRegistry + refactor setup.ts to use ProviderRegistry"
```

---

### Task 4: Update server.ts to pass registry through

**Files:**
- Modify: `src/server.ts`
- Modify: `src/chat/setup.ts` (return type includes registry)

**Step 1: Update setup.ts return type**

Change `ChatSetupResult` to include `registry: ProviderRegistry`. Update `setupChatProvider` to build and return the registry.

**Step 2: Update server.ts**

Extract `registry` from `setupChatProvider` result. Store it for later use by ChannelManager and SubagentManager (Phase 2 & 3).

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/server.ts src/chat/setup.ts
git commit -m "refactor: pass ProviderRegistry through server.ts"
```

---

## Phase 2: Channel Abstraction

### Task 5: Channel types and ChannelManager

**Files:**
- Create: `src/channels/types.ts`
- Create: `src/channels/manager.ts`
- Test: `test/channels/manager.test.ts`

**Step 1: Write the failing test**

```typescript
// test/channels/manager.test.ts
import { describe, it, expect, vi } from "vitest";
import { ChannelManager } from "../../src/channels/manager.js";
import type { Channel, ChannelContext } from "../../src/channels/types.js";

function fakeChannel(name: string): Channel & { started: boolean; stopped: boolean } {
  return {
    name,
    started: false,
    stopped: false,
    async start() { this.started = true; },
    async stop() { this.stopped = true; },
  };
}

describe("ChannelManager", () => {
  it("registers and starts all channels", async () => {
    const manager = new ChannelManager();
    const ch1 = fakeChannel("web");
    const ch2 = fakeChannel("lark");

    manager.register(ch1);
    manager.register(ch2);

    await manager.startAll({} as ChannelContext);

    expect(ch1.started).toBe(true);
    expect(ch2.started).toBe(true);
  });

  it("stops all channels", async () => {
    const manager = new ChannelManager();
    const ch = fakeChannel("web");
    manager.register(ch);
    await manager.startAll({} as ChannelContext);
    await manager.stopAll();
    expect(ch.stopped).toBe(true);
  });

  it("list() returns registered channel names", () => {
    const manager = new ChannelManager();
    manager.register(fakeChannel("web"));
    manager.register(fakeChannel("lark"));
    expect(manager.list()).toEqual(["web", "lark"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/channels/manager.test.ts`
Expected: FAIL — modules not found

**Step 3: Write implementation**

```typescript
// src/channels/types.ts
import type { Hono } from "hono";
import type { ConversationResult } from "../chat/conversation.js";
import type { ChatEvent } from "../chat/types.js";
import type { SessionManager } from "../sessions/manager.js";
import type { MemoryManager } from "../memory/manager.js";
import type { EventLog } from "../core/event-bus.js";

export type InboundMessage = {
  userId: string;
  text: string;
  channel: string;
  channelId: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

export type OnEventCallback = (event: ChatEvent) => void | Promise<void>;

export type ChannelContext = {
  app: Hono;
  handleMessage: (
    msg: InboundMessage,
    onEvent?: OnEventCallback,
  ) => Promise<ConversationResult>;
  sessionManager: SessionManager;
  memoryManager?: MemoryManager;
  eventLog: EventLog;
};

export interface Channel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop?(): Promise<void>;
}
```

```typescript
// src/channels/manager.ts
import type { Channel, ChannelContext } from "./types.js";

export class ChannelManager {
  private channels: Channel[] = [];

  register(channel: Channel): void {
    this.channels.push(channel);
  }

  async startAll(ctx: ChannelContext): Promise<void> {
    for (const ch of this.channels) {
      await ch.start(ctx);
      console.log(`[channel] ${ch.name} started`);
    }
  }

  async stopAll(): Promise<void> {
    for (const ch of this.channels) {
      await ch.stop?.();
    }
  }

  list(): string[] {
    return this.channels.map((ch) => ch.name);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/channels/manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/channels/types.ts src/channels/manager.ts test/channels/manager.test.ts
git commit -m "feat: add Channel interface and ChannelManager"
```

---

### Task 6: WebChannel — migrate from chat/router.ts

**Files:**
- Create: `src/channels/web.ts`
- Modify: `src/chat/router.ts` → will be deleted after migration
- Modify: `test/chat/router.test.ts` → move to `test/channels/web.test.ts`

**Step 1: Create WebChannel**

Move all logic from `src/chat/router.ts` into a `WebChannel` class that implements `Channel`:

```typescript
// src/channels/web.ts
import type { Channel, ChannelContext } from "./types.js";
import type { ChatProvider } from "../chat/types.js";
import { handleCommand } from "../chat/commands.js";
import { handleConversation, type ConversationDeps } from "../chat/conversation.js";
import { streamSSE } from "hono/streaming";

export type WebChannelConfig = {
  provider: ChatProvider;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  skillsDirs: string[];
};

export class WebChannel implements Channel {
  readonly name = "web";

  constructor(private config: WebChannelConfig) {}

  async start(ctx: ChannelContext): Promise<void> {
    const { app } = ctx;

    // GET /api/chat — auth check
    app.get("/api/chat", (c) => {
      const userId = c.get("userId") ?? "web-anonymous";
      return c.json({ status: "ok", userId });
    });

    // POST /api/chat — main chat endpoint
    app.post("/api/chat", async (c) => {
      // ... move all logic from chatRouter's POST handler here
      // Use ctx.handleMessage() OR direct handleConversation()
      // Keep slash commands, SSE streaming, heartbeat
    });
  }
}
```

The POST handler body is essentially the same as the current `chatRouter` POST handler, but reads shared deps from `ctx` and channel-specific config from `this.config`.

**Step 2: Move test**

Move `test/chat/router.test.ts` → `test/channels/web.test.ts`. Update imports from `chatRouter` to `WebChannel`. Adapt test setup to create a `ChannelContext` and call `channel.start(ctx)` instead of `chatRouter(app, ...)`.

**Step 3: Run tests**

Run: `npx vitest run test/channels/web.test.ts`
Expected: PASS

**Step 4: Delete old file**

Delete `src/chat/router.ts` (all logic moved to `src/channels/web.ts`).

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/channels/web.ts test/channels/web.test.ts
git rm src/chat/router.ts test/chat/router.test.ts
git commit -m "refactor: migrate chatRouter → WebChannel"
```

---

### Task 7: LarkChannel — migrate from lark/router.ts

**Files:**
- Create: `src/channels/lark.ts`
- Modify: `src/lark/router.ts` → will be deleted after migration
- Modify: `test/lark/router.test.ts` → move to `test/channels/lark.test.ts`

**Step 1: Create LarkChannel**

Move logic from `src/lark/router.ts` into `LarkChannel` class. The dedup cache, webhook handler, and async `processMessage` all move in. Channel-specific config (larkClient, sendCard, patchCard, verificationToken) are in the constructor config.

```typescript
// src/channels/lark.ts
import type { Channel, ChannelContext } from "./types.js";
import type { ChatProvider } from "../chat/types.js";

export type LarkChannelConfig = {
  provider: ChatProvider;
  maxHistoryMessages?: number;
  maxHistoryTokens?: number;
  sendCard: (chatId: string, markdown: string) => Promise<string>;
  patchCard: (messageId: string, markdown: string) => Promise<void>;
  verificationToken?: string;
};

export class LarkChannel implements Channel {
  readonly name = "lark";
  constructor(private config: LarkChannelConfig) {}

  async start(ctx: ChannelContext): Promise<void> {
    const { app } = ctx;
    app.post("/api/lark/webhook", async (c) => {
      // ... move larkRouter webhook handler logic here
    });
  }
}
```

**Step 2: Move test**

Move `test/lark/router.test.ts` → `test/channels/lark.test.ts`. Update imports.

**Step 3: Run tests and verify**

Run: `npx vitest run test/channels/lark.test.ts`
Expected: PASS

**Step 4: Delete old files, clean up lark/ directory**

Delete `src/lark/router.ts`. Keep `src/lark/client.ts` (SDK wrapper is channel-agnostic helper).

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/channels/lark.ts test/channels/lark.test.ts
git rm src/lark/router.ts test/lark/router.test.ts
git commit -m "refactor: migrate larkRouter → LarkChannel"
```

---

### Task 8: Wire ChannelManager into server.ts

**Files:**
- Modify: `src/server.ts`

**Step 1: Refactor server.ts**

Replace direct `chatRouter()` / `larkRouter()` calls with:

```typescript
import { ChannelManager } from "./channels/manager.js";
import { WebChannel } from "./channels/web.js";
import { LarkChannel } from "./channels/lark.js";

// In createApp():
const channelManager = new ChannelManager();
channelManager.register(new WebChannel({ provider: chatProvider, skillsDirs, ... }));

if (env.LARK_APP_ID && env.LARK_APP_SECRET) {
  const larkClient = createLarkClient(env);
  channelManager.register(new LarkChannel({
    provider: chatProvider,
    sendCard: (chatId, md) => sendCard(larkClient, chatId, md),
    patchCard: (msgId, md) => patchCard(larkClient, msgId, md),
    verificationToken: env.LARK_VERIFICATION_TOKEN,
  }));
}

const handleMessage = (msg, onEvent?) => handleConversation({
  userId: msg.userId,
  message: msg.text,
  sessionId: msg.sessionId,
  channel: msg.channel,
  channelId: msg.channelId,
  deps: { provider: chatProvider, sessionManager, eventLog, memoryManager, maxHistoryTokens: env.CHAT_MAX_HISTORY_TOKENS },
  onEvent,
});

await channelManager.startAll({
  app,
  handleMessage,
  sessionManager,
  memoryManager,
  eventLog,
});

// Log which channels are active
console.log(`[init] Channels: ${channelManager.list().join(", ")}`);
```

Remove old imports of `chatRouter`, `larkRouter`.

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "refactor: wire ChannelManager into server.ts"
```

---

## Phase 3: Subagent/Spawn

### Task 9: SubagentManager core class

**Files:**
- Create: `src/subagent/manager.ts`
- Test: `test/subagent/manager.test.ts`

**Step 1: Write the failing test**

```typescript
// test/subagent/manager.test.ts
import { describe, it, expect, vi } from "vitest";
import { SubagentManager } from "../../src/subagent/manager.js";
import { ProviderRegistry } from "../../src/chat/provider-registry.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { createTestDb } from "../helpers.js";
import type { ChatProvider } from "../../src/chat/types.js";

function fakeProvider(reply: string): ChatProvider {
  return {
    name: "test",
    async *stream() {
      yield { type: "text" as const, content: reply };
      yield { type: "done" as const, sessionId: "", costUsd: 0 };
    },
  };
}

describe("SubagentManager", () => {
  it("spawns a task and writes result to parent session", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => fakeProvider("task result here"),
    });

    const parentSession = sessionManager.create({
      userId: "user-1",
      channel: "web",
      channelId: "",
      provider: "test",
    });

    const manager = new SubagentManager({ registry, sessionManager });

    const taskId = manager.spawn({
      task: "research something",
      parentSessionId: parentSession.id,
      userId: "user-1",
      providerName: "test",
    });

    expect(taskId).toBeTruthy();

    // Wait for async completion
    await vi.waitFor(() => {
      const task = manager.getTask(taskId);
      expect(task?.status).toBe("completed");
    }, { timeout: 5000 });

    // Result should be written to parent session
    const messages = sessionManager.getMessages(parentSession.id);
    const systemMsg = messages.find(
      (m) => m.role === "system" && m.content.includes("task result here"),
    );
    expect(systemMsg).toBeTruthy();
  });

  it("lists tasks by session", () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => fakeProvider("ok"),
    });

    const manager = new SubagentManager({ registry, sessionManager });

    manager.spawn({
      task: "task a",
      parentSessionId: "session-1",
      userId: "user-1",
      providerName: "test",
    });
    manager.spawn({
      task: "task b",
      parentSessionId: "session-1",
      userId: "user-1",
      providerName: "test",
    });
    manager.spawn({
      task: "task c",
      parentSessionId: "session-2",
      userId: "user-1",
      providerName: "test",
    });

    expect(manager.listBySession("session-1")).toHaveLength(2);
    expect(manager.listBySession("session-2")).toHaveLength(1);
  });

  it("cancels tasks by session", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();

    // Provider that never finishes
    let blocked = true;
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => ({
        name: "test",
        async *stream() {
          while (blocked) await new Promise((r) => setTimeout(r, 50));
          yield { type: "done" as const, sessionId: "", costUsd: 0 };
        },
      }),
    });

    const manager = new SubagentManager({ registry, sessionManager });

    manager.spawn({
      task: "long task",
      parentSessionId: "session-1",
      userId: "user-1",
      providerName: "test",
    });

    const cancelled = manager.cancelBySession("session-1");
    expect(cancelled).toBe(1);

    const tasks = manager.listBySession("session-1");
    expect(tasks[0].status).toBe("cancelled");

    blocked = false; // cleanup
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/subagent/manager.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/subagent/manager.ts
import { randomUUID } from "node:crypto";
import type { ProviderRegistry } from "../chat/provider-registry.js";
import type { SessionManager } from "../sessions/manager.js";
import { handleConversation, type ConversationDeps } from "../chat/conversation.js";
import { EventLog } from "../core/event-bus.js";

export type SubagentTask = {
  id: string;
  task: string;
  parentSessionId: string;
  userId: string;
  providerName: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
};

export type SpawnOpts = {
  task: string;
  parentSessionId: string;
  userId: string;
  providerName: string;
};

export type SubagentManagerConfig = {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
};

export class SubagentManager {
  private tasks = new Map<string, SubagentTask>();
  private abortControllers = new Map<string, AbortController>();

  constructor(private config: SubagentManagerConfig) {}

  spawn(opts: SpawnOpts): string {
    const id = randomUUID();
    const task: SubagentTask = {
      id,
      task: opts.task,
      parentSessionId: opts.parentSessionId,
      userId: opts.userId,
      providerName: opts.providerName,
      status: "running",
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);

    const controller = new AbortController();
    this.abortControllers.set(id, controller);

    this.run(task, controller.signal).catch((err) => {
      if (task.status === "running") {
        task.status = "failed";
        task.error = err.message ?? String(err);
        task.completedAt = Date.now();
      }
    });

    return id;
  }

  private async run(task: SubagentTask, signal: AbortSignal): Promise<void> {
    const { registry, sessionManager } = this.config;

    const provider = registry.create(task.providerName);

    const deps: ConversationDeps = {
      provider,
      sessionManager,
      eventLog: { log: () => {} } as unknown as EventLog,
      // No memoryManager — subagents don't access memories
    };

    const result = await handleConversation({
      userId: task.userId,
      message: task.task,
      channel: "subagent",
      channelId: task.id,
      deps,
      abortSignal: signal,
    });

    if (task.status !== "running") return; // was cancelled

    task.status = "completed";
    task.result = result.text;
    task.completedAt = Date.now();

    // Write result to parent session
    sessionManager.appendMessage(task.parentSessionId, {
      role: "system",
      content: `[后台任务完成] ${task.task}\n\n结果: ${result.text}`,
    });
  }

  getTask(id: string): SubagentTask | undefined {
    return this.tasks.get(id);
  }

  listBySession(sessionId: string): SubagentTask[] {
    return [...this.tasks.values()].filter(
      (t) => t.parentSessionId === sessionId,
    );
  }

  cancelBySession(sessionId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.parentSessionId === sessionId && task.status === "running") {
        task.status = "cancelled";
        task.completedAt = Date.now();
        this.abortControllers.get(task.id)?.abort();
        count++;
      }
    }
    return count;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/subagent/manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/subagent/manager.ts test/subagent/manager.test.ts
git commit -m "feat: add SubagentManager with spawn, cancel, and result reporting"
```

---

### Task 10: SpawnTool

**Files:**
- Create: `src/tools/spawn.ts`
- Test: `test/tools/spawn.test.ts`

**Step 1: Write the failing test**

```typescript
// test/tools/spawn.test.ts
import { describe, it, expect, vi } from "vitest";
import { createSpawnTool } from "../../src/tools/spawn.js";
import { SubagentManager } from "../../src/subagent/manager.js";
import { ProviderRegistry } from "../../src/chat/provider-registry.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { createTestDb } from "../helpers.js";

describe("spawn tool", () => {
  it("calls subagentManager.spawn and returns task id", async () => {
    const db = createTestDb();
    const sessionManager = new SessionManager(db);
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => ({
        name: "test",
        async *stream() {
          yield { type: "text" as const, content: "done" };
          yield { type: "done" as const, sessionId: "", costUsd: 0 };
        },
      }),
    });

    const manager = new SubagentManager({ registry, sessionManager });
    const tool = createSpawnTool(manager, "test");

    const result = await tool.execute(
      { task: "research something" },
      { userId: "user-1", sessionId: "session-1" },
    );

    expect(result).toContain("后台任务已启动");
    expect(manager.listBySession("session-1")).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/spawn.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/tools/spawn.ts
import { z } from "zod";
import type { UnifiedToolDef, ToolContext } from "./types.js";
import type { SubagentManager } from "../subagent/manager.js";

export function createSpawnTool(
  subagentManager: SubagentManager,
  defaultProvider: string,
): UnifiedToolDef {
  return {
    name: "spawn",
    description:
      "在后台启动一个子任务，不阻塞当前对话。适合耗时的研究、分析任务。完成后结果会自动写入当前会话。",
    inputSchema: {
      task: z.string().describe("子任务的详细描述，要足够具体以便独立执行"),
      provider: z
        .string()
        .optional()
        .describe("使用的 provider 名称，默认与当前对话相同"),
    },
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "子任务的详细描述，要足够具体以便独立执行",
        },
        provider: {
          type: "string",
          description: "使用的 provider 名称，默认与当前对话相同",
        },
      },
      required: ["task"],
    },
    execute: async (args: { task: string; provider?: string }, ctx: ToolContext) => {
      const taskId = subagentManager.spawn({
        task: args.task,
        parentSessionId: ctx.sessionId,
        userId: ctx.userId,
        providerName: args.provider ?? defaultProvider,
      });
      return `后台任务已启动 (id=${taskId})，完成后会自动通知你。`;
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools/spawn.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tools/spawn.ts test/tools/spawn.test.ts
git commit -m "feat: add spawn tool for background subagent tasks"
```

---

### Task 11: /tasks and /stop slash commands

**Files:**
- Modify: `src/chat/commands.ts`
- Modify: `test/chat/commands.test.ts`

**Step 1: Write the failing tests**

Append to `test/chat/commands.test.ts`:

```typescript
import { SubagentManager } from "../../src/subagent/manager.js";
import { ProviderRegistry } from "../../src/chat/provider-registry.js";

describe("handleCommand — /tasks", () => {
  it("lists background tasks for current session", async () => {
    const s = setup();
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => ({ name: "test", async *stream() { /* never finishes */ } }),
    });
    const subagentManager = new SubagentManager({
      registry,
      sessionManager: s.sessionManager,
    });

    subagentManager.spawn({
      task: "research AI",
      parentSessionId: s.session.id,
      userId: "user-1",
      providerName: "test",
    });

    const result = await handleCommand("/tasks", {
      ...ctx(s),
      subagentManager,
    });

    expect(result).toBeTruthy();
    const text = (result!.events[0] as any).content;
    expect(text).toContain("research AI");
    expect(text).toContain("running");
  });
});

describe("handleCommand — /stop", () => {
  it("cancels running tasks for current session", async () => {
    const s = setup();
    const registry = new ProviderRegistry();
    registry.register({
      name: "test",
      type: "openai-compatible",
      factory: () => ({
        name: "test",
        async *stream() {
          await new Promise((r) => setTimeout(r, 10000));
          yield { type: "done" as const, sessionId: "", costUsd: 0 };
        },
      }),
    });
    const subagentManager = new SubagentManager({
      registry,
      sessionManager: s.sessionManager,
    });

    subagentManager.spawn({
      task: "long task",
      parentSessionId: s.session.id,
      userId: "user-1",
      providerName: "test",
    });

    const result = await handleCommand("/stop", {
      ...ctx(s),
      subagentManager,
    });

    expect(result).toBeTruthy();
    const text = (result!.events[0] as any).content;
    expect(text).toContain("1");
    expect(text).toContain("cancelled");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat/commands.test.ts`
Expected: FAIL — `subagentManager` not in CommandContext

**Step 3: Write implementation**

Add `subagentManager?: SubagentManager` to `CommandContext` type. Add two new cases to the switch:

```typescript
case "/tasks":
  return handleTasks(ctx);
case "/stop":
  return handleStop(ctx);
```

```typescript
function handleTasks(ctx: CommandContext): CommandResult {
  if (!ctx.subagentManager) {
    return textResult(ctx.session.id, "No background tasks available.");
  }
  const tasks = ctx.subagentManager.listBySession(ctx.session.id);
  if (tasks.length === 0) {
    return textResult(ctx.session.id, "No background tasks.");
  }
  const lines = tasks.map((t) => {
    const elapsed = t.completedAt
      ? `${Math.round((t.completedAt - t.createdAt) / 1000)}s`
      : `${Math.round((Date.now() - t.createdAt) / 1000)}s`;
    return `- [${t.status}] ${t.task.slice(0, 80)} (${elapsed})`;
  });
  return textResult(ctx.session.id, `Background tasks (${tasks.length}):\n${lines.join("\n")}`);
}

function handleStop(ctx: CommandContext): CommandResult {
  if (!ctx.subagentManager) {
    return textResult(ctx.session.id, "No background tasks to stop.");
  }
  const count = ctx.subagentManager.cancelBySession(ctx.session.id);
  return textResult(ctx.session.id, count > 0
    ? `${count} task(s) cancelled.`
    : "No running tasks to cancel.");
}
```

Also update `/help` to include `/tasks` and `/stop`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat/commands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/chat/commands.ts test/chat/commands.test.ts
git commit -m "feat: add /tasks and /stop slash commands for subagent management"
```

---

### Task 12: Wire spawn tool + SubagentManager into server.ts

**Files:**
- Modify: `src/tools/suite.ts`
- Modify: `src/server.ts`

**Step 1: Add spawn tool to buildToolSuite**

Add optional `subagentManager` + `defaultProvider` params to `buildToolSuite`. If provided, include `createSpawnTool(subagentManager, defaultProvider)` in the tool defs list.

**Step 2: Update server.ts**

After creating the registry and provider:

```typescript
import { SubagentManager } from "./subagent/manager.js";

const subagentManager = new SubagentManager({ registry, sessionManager });

// Pass to tool suite
const toolSuite = buildToolSuite(env, skillsDirs, memoryManager, {
  subagentManager,
  defaultProvider: env.CHAT_PROVIDER ?? "claude",
});

// Pass to WebChannel for slash commands
channelManager.register(new WebChannel({
  provider: chatProvider,
  skillsDirs,
  subagentManager,  // new
  ...
}));
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/tools/suite.ts src/server.ts
git commit -m "feat: wire SubagentManager + spawn tool into server"
```

---

### Task 13: Final integration test and cleanup

**Files:**
- Run full test suite
- Verify build

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Verify build**

Run: `npm run build`
Expected: Clean compile with no errors

**Step 3: Remove dead imports/files**

Check for any stale imports referencing old `chatRouter` or `larkRouter`. Remove `src/lark/router.ts` and `test/lark/router.test.ts` if not done in earlier steps.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: final cleanup after nanobot-inspired refactor"
```
