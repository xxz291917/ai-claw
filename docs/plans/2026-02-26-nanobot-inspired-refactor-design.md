# Nanobot-Inspired Architecture Refactor

**Date:** 2026-02-26
**Status:** Design approved, pending implementation plan
**Scope:** Channel abstraction + MessageBus, Provider Registry, Subagent/Spawn

## Background

对比 [nanobot](https://github.com/...) 项目后，识别出三个值得借鉴的架构模式。本次重构旨在提升渠道扩展性、Provider 灵活性和后台任务能力。

---

## Part 1: Channel 抽象层 + Event-based MessageBus

### 动机

当前 Web router (`src/chat/router.ts`) 和 Lark router (`src/lark/router.ts`) 各自直接调用 `handleConversation()`，没有统一抽象。新增渠道需要从零写路由、session 解析、错误处理等样板代码。

### 方案选择

选择 **Event-based MessageBus**（方案 B）：

- 引入 `Channel` 接口 + `ChannelManager`，但不引入 async queue
- Channel 通过 `onEvent` 回调消费实时事件（保留 SSE 流式能力）
- `handleConversation()` 保持不变，已天然支持 `onEvent`

放弃全量 Queue MessageBus（方案 A）的原因：Web SSE 需要逐 token 实时推送，queue 模式下需要把 AgentLoop 改为写细粒度事件到 queue，改动过大。

### 核心接口

```typescript
// src/channels/types.ts

/** 入站消息 — Channel 解析协议后产出的统一格式 */
export type InboundMessage = {
  userId: string;
  text: string;
  channel: string;       // "web" | "lark" | ...
  channelId: string;     // chat_id / room_id
  sessionId?: string;    // 客户端指定的 session（Web 有，Lark 无）
  metadata?: Record<string, unknown>;  // 渠道特有信息
};

/** Channel 生命周期接口 */
export interface Channel {
  readonly name: string;

  /** 注册 HTTP 路由或启动长连接 */
  start(ctx: ChannelContext): Promise<void>;

  /** 优雅关闭 */
  stop?(): Promise<void>;
}

/** ChannelManager 注入给每个 Channel 的上下文 */
export type ChannelContext = {
  app: Hono;
  handleMessage: (msg: InboundMessage, onEvent?: OnEventCallback) => Promise<ConversationResult>;
  sessionManager: SessionManager;
  memoryManager?: MemoryManager;
  eventLog: EventLog;
};
```

### ChannelManager

```typescript
// src/channels/manager.ts

export class ChannelManager {
  private channels: Channel[] = [];

  register(channel: Channel): void;

  /** 启动所有已注册 Channel */
  async startAll(ctx: ChannelContext): Promise<void>;

  /** 优雅关闭所有 Channel */
  async stopAll(): Promise<void>;
}
```

### Channel 实现

**WebChannel** (`src/channels/web.ts`):
- 封装现有 `src/chat/router.ts` 的逻辑
- HTTP POST `/api/chat`、SSE 流式、slash commands、heartbeat
- `onEvent` → `stream.writeSSE()`

**LarkChannel** (`src/channels/lark.ts`):
- 封装现有 `src/lark/router.ts` 的逻辑
- Webhook 接收、dedup、fire-and-forget、card send/patch
- 收集所有事件，`done` 时 patch card

### server.ts 变化

```typescript
// Before:
chatRouter(app, chatProvider, { ... });
larkRouter(app, { ... });

// After:
const manager = new ChannelManager();
manager.register(new WebChannel({ provider, skillsDirs, ... }));
if (env.LARK_APP_ID) {
  manager.register(new LarkChannel({ larkClient, ... }));
}
await manager.startAll({ app, handleMessage, sessionManager, ... });
```

### 要点

- `handleConversation()` 保持不变
- 协议细节（SSE、webhook、card）留在各自 Channel 实现中
- Slash commands 留在 WebChannel
- 新增渠道只需实现 `Channel` 接口 + 注册

---

## Part 2: Provider Registry

### 动机

当前 `setupChatProvider()` 用 if-else 选择 Claude 或 Generic。未来需要接入多个 OpenAI-compatible 端点（DeepSeek、Qwen、Ollama 等），if-else 不可扩展。

### 核心设计

```typescript
// src/chat/provider-registry.ts

export type ProviderFactory = (opts: ProviderFactoryOpts) => ChatProvider;

export type ProviderSpec = {
  name: string;
  type: "claude" | "openai-compatible";
  factory: ProviderFactory;
};

export class ProviderRegistry {
  private specs = new Map<string, ProviderSpec>();

  register(spec: ProviderSpec): void;
  create(name: string, opts: ProviderFactoryOpts): ChatProvider;
  list(): ProviderSpec[];
}
```

### 环境变量约定

多 provider 配置采用 `PROVIDER_{NAME}_*` 前缀：

```
CHAT_PROVIDER=deepseek            # 默认 provider

# Claude (特殊 — 使用 Agent SDK)
ANTHROPIC_API_KEY=...

# OpenAI-compatible providers
PROVIDER_DEEPSEEK_API_BASE=https://api.deepseek.com
PROVIDER_DEEPSEEK_API_KEY=sk-...
PROVIDER_DEEPSEEK_MODEL=deepseek-chat

PROVIDER_QWEN_API_BASE=https://...
PROVIDER_QWEN_API_KEY=sk-...
PROVIDER_QWEN_MODEL=qwen-turbo
```

### 内置注册

- `claude`: 始终注册（需要 `ANTHROPIC_API_KEY`）
- 其他 provider: 扫描 `PROVIDER_{NAME}_API_BASE` + `PROVIDER_{NAME}_API_KEY` 环境变量，自动注册为 GenericProvider 实例

### setup.ts 变化

```typescript
// Before:
const isGeneric = env.CHAT_PROVIDER === "generic" && ...;
if (isGeneric) { ... } else { ... }

// After:
const registry = buildDefaultRegistry(env);
const provider = registry.create(env.CHAT_PROVIDER ?? "claude", { env, systemPrompt, ... });
```

### Subagent 联动

Subagent 可通过 `provider` 参数选择不同 provider（如主对话用 Claude，后台任务用 DeepSeek），Registry 使这变得自然。

---

## Part 3: Subagent/Spawn

### 动机

AI 需要执行耗时的后台任务（研究、分析）时，当前只能阻塞对话等待完成。需要一个后台执行机制。

### SpawnTool

```typescript
// src/tools/spawn.ts
{
  name: "spawn",
  description: "在后台启动一个子任务，不阻塞当前对话。适合耗时的研究、分析任务。",
  inputSchema: {
    task: z.string().describe("子任务的详细描述"),
    provider: z.string().optional().describe("使用的 provider 名称，默认与当前对话相同"),
  },
  execute: async (args, ctx) => {
    const taskId = subagentManager.spawn({
      task: args.task,
      parentSessionId: ctx.sessionId,
      userId: ctx.userId,
      provider: args.provider,
    });
    return `后台任务已启动 (id=${taskId})，完成后会通知你。`;
  }
}
```

### SubagentManager

```typescript
// src/subagent/manager.ts

export type SubagentTask = {
  id: string;
  task: string;
  parentSessionId: string;
  userId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
};

export class SubagentManager {
  private tasks = new Map<string, SubagentTask>();

  constructor(
    private registry: ProviderRegistry,
    private sessionManager: SessionManager,
    private toolSuite: ToolSuiteResult,
  ) {}

  spawn(opts: SpawnOpts): string;

  private async run(task: SubagentTask): Promise<void> {
    // 1. 创建独立 session
    // 2. 用指定 provider 执行（精简工具集）
    // 3. 结果写入父 session 的 system 消息
    // 4. 标记任务完成
  }

  cancelBySession(sessionId: string): number;
  listBySession(sessionId: string): SubagentTask[];
}
```

### 精简工具集

子任务可用的工具（排除递归和写入风险）：

| 可用 | 不可用（排除原因） |
|------|---------------------|
| web_search | spawn（防递归） |
| web_fetch | claude_code（重量级） |
| file_read | memory_save/delete（副作用） |
| bash_exec（只读） | file_write（副作用） |
| get_skill | |

### 结果回传机制

子任务完成后，结果作为 `system` 消息追加到父 session：

```
[后台任务完成] {task描述}

结果: {result文本}
```

下次用户发消息时，AI 自然能看到这些结果并汇报。

### 用户交互

- `/tasks` slash command: 列出当前 session 的后台任务及状态
- `/stop` slash command: 取消当前 session 的所有运行中任务

### 数据流

```
用户: "帮我研究一下 nanobot 的架构"
  → AI 调用 spawn(task="分析 nanobot 项目架构...")
  → AI 回复: "好的，我已经启动了一个后台任务来研究"
  → [后台] SubagentManager 用 provider 开新 session 执行分析
  → [后台完成] 结果写入父 session 的 system 消息
  → 用户下次发消息时，AI 看到结果并主动汇报
```

---

## 实现顺序

建议按依赖关系排序：

1. **Provider Registry** — 无外部依赖，最先落地
2. **Channel 抽象层** — 依赖 Registry（ChannelContext 需要引用 provider）
3. **Subagent/Spawn** — 依赖 Registry（子任务可选不同 provider）+ Channel 完成后 server.ts 结构更清晰

---

## 影响范围

| 模块 | 变化 |
|------|------|
| `src/chat/setup.ts` | 重构为使用 ProviderRegistry |
| `src/chat/router.ts` | 移动到 `src/channels/web.ts` |
| `src/lark/router.ts` | 移动到 `src/channels/lark.ts` |
| `src/server.ts` | 使用 ChannelManager + ProviderRegistry |
| `src/env.ts` | 新增 `PROVIDER_*` 环境变量解析 |
| `src/tools/suite.ts` | 新增 spawn 工具注册 |
| `src/chat/commands.ts` | 新增 `/tasks`, `/stop` 命令 |
| 新文件 | `src/channels/`, `src/chat/provider-registry.ts`, `src/subagent/`, `src/tools/spawn.ts` |
