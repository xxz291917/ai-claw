# Event Bus + Adapter 架构设计

## 背景

AI Hub 当前有两条独立路径（fault-healing pipeline + chat assistant），需要演进为统一的分层架构，支持多输入源、多输出目标、多 LLM Provider，以及约 100 名内部用户通过 Lark 使用。

## 架构总览

```
┌─────────────────────────────────────────────┐
│              Input Adapters                  │
│  Sentry │ Notion │ Lark │ Web Chat          │
│         ↓ 标准化 HubEvent ↓                  │
├─────────────────────────────────────────────┤
│              EventBus (内存)                  │
├─────────────────────────────────────────────┤
│              Core (混合决策)                   │
│  RuleRouter (已知场景) + OrchestratorAgent   │
│  SessionManager (会话管理)                    │
│  Executor (任务调度)                          │
├─────────────────────────────────────────────┤
│              Sub-Agents                      │
│  code-fixer │ code-reviewer │ doc-writer │   │
│  analyzer │ ...                              │
│         ↑ Skills & Tools ↑                   │
├─────────────────────────────────────────────┤
│              Output Adapters                 │
│  Lark │ GitHub PR │ Notion │ Web Chat SSE   │
└─────────────────────────────────────────────┘
```

## Section 1: 核心抽象与数据流

### HubEvent — 统一事件模型

```typescript
interface HubEvent {
  id: string;                    // 唯一事件 ID (nanoid)
  type: string;                  // "sentry.issue_alert", "notion.task_created", "chat.message" 等
  source: string;                // "sentry", "notion", "chat", "lark"
  payload: Record<string, any>;  // 原始数据
  metadata: {
    receivedAt: string;
    traceId?: string;            // 同一任务链共享
  };
  context?: {
    sessionId?: string;
    userId?: string;
    replyTo?: string;            // 群聊回复的消息 ID
  };
}
```

### 核心接口

```typescript
interface InputAdapter {
  readonly source: string;
  toEvent(raw: unknown): HubEvent | null;
}

interface OutputAdapter {
  readonly target: string;
  send(action: OutputAction): Promise<void>;
}

type OutputAction =
  | { type: "notify"; channel: string; card: CardPayload }
  | { type: "create_pr"; repo: string; branch: string; title: string; body: string }
  | { type: "update_task"; taskId: string; status: string; result?: string }
  | { type: "stream_chat"; sessionId: string; events: AsyncIterable<ChatEvent> };
```

### 数据流

```
外部请求 → Hono route handler
  → InputAdapter.toEvent(raw)
  → EventBus.emit(event)
  → Core.handle(event)
    → RuleRouter.match(event)
      ├─ 匹配 → 直接调度 SubAgent
      └─ 未匹配 → OrchestratorAgent.plan(event)
    → SubAgent.execute(task)
    → OutputAdapter.send(action)
```

EventBus 是同步内存实现，不引入 Redis/MQ。未来需要分布式时可替换为 MQ 而不影响上下游。

## Section 2: 会话管理

### 设计动机

- 100 个用户并发，需隔离对话上下文
- 群聊场景需区分独立问题 vs 同一话题跟进
- 多轮对话需要上下文连续性
- 需兼容 Claude Agent SDK 和 OpenAI 兼容 API（DeepSeek/Kimi 等）

### 数据模型

```typescript
interface Session {
  id: string;
  userId: string;
  channel: string;                // "lark_p2p" | "lark_group" | "web_chat"
  channelId: string;
  provider: string;               // "claude" | "deepseek" | "kimi" | ...
  providerSessionId?: string;     // Claude SDK session ID（仅 Claude 有）
  status: "active" | "closed";
  createdAt: string;
  lastActiveAt: string;
}

interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: string;             // JSON
  createdAt: string;
}
```

### 会话路由策略

- **Lark 私聊**: userId + channel → 查找最近 active session → 复用或创建
- **Lark 群聊**: userId + channelId + reply_thread → 跟进复用 or 新建
- **Web Chat**: 前端生成 sessionId，保持现有逻辑

### 多 Provider 的 resume 策略

- **ClaudeProvider**: 优先用 providerSessionId 做 SDK resume；首次对话用 messages
- **GenericProvider**: 每次从 messages 表加载历史，拼入 API 请求（stateless API）

### 存储

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  last_active_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_session ON messages(session_id, created_at);
```

### ChatProvider 接口

```typescript
interface ChatProvider {
  readonly name: string;
  chat(
    messages: Message[],
    session: Session,
    options?: ChatOptions,
  ): AsyncIterable<ChatEvent>;
}
```

### 不做什么

- 不做用户系统 — 直接用 Lark open_id
- 不做 session 过期清理 — 先标记 status，后续按需加 TTL

## Section 3: Core 层 — 混合决策引擎

### 结构

```
HubEvent → Core.handle(event)
  1. chat 类事件 → SessionManager → ChatProvider（实时对话）
  2. RuleRouter.match(event) → TaskPlan（规则匹配，快速确定）
  3. OrchestratorAgent.plan(event) → TaskPlan（AI 决策，灵活兜底）
  → Executor.run(plan)
```

### RuleRouter

硬编码已知场景，零 LLM 调用：

```typescript
interface Route {
  match: (event: HubEvent) => boolean;
  plan: (event: HubEvent) => TaskPlan;
}

const routes: Route[] = [
  {
    match: (e) => e.type === "sentry.issue_alert",
    plan: (e) => ({
      agent: "code-fixer",
      skill: "fault-healing",
      inputs: { issueId: e.payload.issue_id },
      outputs: [{ target: "lark", action: "notify" }, { target: "github", action: "create_pr" }],
    }),
  },
  // ...更多规则
];
```

### OrchestratorAgent

RuleRouter 未匹配时，用一次 LLM 调用做决策，输出 TaskPlan：

```typescript
interface TaskPlan {
  agent: string;
  skill?: string;
  inputs: Record<string, any>;
  outputs: OutputAction[];
}

class OrchestratorAgent {
  async plan(event: HubEvent): Promise<TaskPlan> {
    // system prompt 注入可用 agents、skills、output targets
    // 返回结构化 JSON
  }
}
```

### Core 主逻辑

```typescript
class Core {
  async handle(event: HubEvent): Promise<void> {
    if (event.type.startsWith("chat.")) {
      return this.handleChat(event);
    }
    const plan = this.ruleRouter.match(event);
    if (plan) {
      return this.executor.run(plan, event);
    }
    const aiPlan = await this.orchestratorAgent.plan(event);
    return this.executor.run(aiPlan, event);
  }
}
```

## Section 4: Sub-Agents 与 Executor

### SubAgent 接口

```typescript
interface SubAgent {
  readonly name: string;
  readonly description: string;
  execute(task: TaskExecution): AsyncIterable<AgentEvent>;
}

interface TaskExecution {
  taskId: string;
  skill?: string;
  inputs: Record<string, any>;
  provider: string;
  tools?: string[];
}

type AgentEvent =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; tool: string; input: Record<string, any> }
  | { type: "tool_result"; tool: string; output: string }
  | { type: "result"; content: string; artifacts?: Artifact[] }
  | { type: "error"; message: string };

interface Artifact {
  kind: "pr" | "document" | "analysis" | "patch";
  data: Record<string, any>;
}
```

### 预置 Sub-Agents

| Agent | 职责 |
|-------|------|
| code-fixer | 分析 bug、写修复代码、创建 PR（迁移自 fault-healing） |
| code-reviewer | 代码审查、提出改进建议 |
| doc-writer | 写/更新文档、生成报告 |
| analyzer | 技术调研、数据分析、方案设计 |

初期只迁移 code-fixer，其余后续按需添加。

### Executor

```typescript
class Executor {
  async run(plan: TaskPlan, event: HubEvent): Promise<void> {
    const taskId = this.taskStore.create({ type: plan.agent, source: event.source, eventId: event.id, state: "pending" });
    const agent = this.agents.get(plan.agent);
    const execution: TaskExecution = { taskId, skill: plan.skill, inputs: plan.inputs, provider: plan.provider ?? "claude" };
    for await (const agentEvent of agent.execute(execution)) {
      this.auditLog.append(taskId, agentEvent);
      if (agentEvent.type === "result") {
        for (const output of plan.outputs) {
          await this.outputBus.send(output, agentEvent);
        }
      }
    }
    this.taskStore.transition(taskId, "complete");
  }
}
```

### 与现有代码的映射

- `FaultHealingWorkflow.analyze()` / `.fix()` → code-fixer agent + fault-healing skill
- `runAgent()` → SubAgent.execute() 的内部实现
- `TaskStore` → 保留，由 Executor 调用

## Section 5: Input / Output Adapters

### Input Adapters

| Adapter | 来源 | 产出事件类型 | 迁移自 |
|---------|------|-------------|--------|
| SentryInputAdapter | Sentry webhook | sentry.issue_alert | webhooks/sentry.ts |
| NotionInputAdapter | Notion webhook | notion.task_created, notion.task_updated | 新增 |
| LarkInputAdapter | Lark 事件 | lark.card_action, chat.lark_group, chat.lark_p2p | lark/callback.ts |
| WebChatInputAdapter | Web Chat | chat.web | chat/router.ts |

### Output Adapters

| Adapter | 目标 | 支持的 action | 迁移自 |
|---------|------|--------------|--------|
| LarkOutputAdapter | Lark | notify, stream_chat | lark/notify.ts |
| GitHubOutputAdapter | GitHub | create_pr | 新增（从 agent bash 提取） |
| NotionOutputAdapter | Notion | update_task | 新增 |
| WebChatOutputAdapter | Web Chat | stream_chat | chat/router.ts |

### 路由层

重构后路由处理器只做 HTTP 协议处理：

```typescript
app.post("/webhooks/sentry", async (c) => {
  const event = sentryAdapter.toEvent(await c.req.json());
  if (event) eventBus.emit(event);
  return c.json({ ok: true });
});
```

## Section 6: EventBus 与整体组装

### EventBus

轻量内存实现，所有事件持久化到 event_log 表：

```typescript
class EventBus {
  on(pattern: string, handler: (event: HubEvent) => Promise<void>): void;
  async emit(event: HubEvent): Promise<void> {
    this.eventStore.append(event);
    for (const handler of this.match(event.type)) {
      await handler(event);
    }
  }
}
```

```sql
CREATE TABLE event_log (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  context TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_event_log_type ON event_log(type, created_at);
```

### 应用组装

```typescript
export function createApp(env: Env) {
  const db = createDb(env);
  const eventBus = new EventBus(db);
  const sessionManager = new SessionManager(db);
  const taskStore = new TaskStore(db);

  const outputs = new OutputBus([
    new LarkOutputAdapter(env),
    new GitHubOutputAdapter(env),
    new NotionOutputAdapter(env),
    new WebChatOutputAdapter(),
  ]);

  const agents = new AgentRegistry([
    new CodeFixerAgent(env),
  ]);

  const core = new Core({
    ruleRouter: new RuleRouter(routes),
    orchestratorAgent: new OrchestratorAgent(env),
    sessionManager, taskStore, agents, outputs,
  });

  eventBus.on("*", (event) => core.handle(event));
  // ... 薄路由层
}
```

### 目录结构

```
src/
├── core/
│   ├── event-bus.ts
│   ├── hub-event.ts
│   ├── core.ts
│   ├── rule-router.ts
│   ├── orchestrator-agent.ts
│   └── executor.ts
├── adapters/
│   ├── input/   (types.ts, sentry.ts, notion.ts, lark.ts, web-chat.ts)
│   └── output/  (types.ts, lark.ts, github.ts, notion.ts, web-chat.ts)
├── agents/
│   ├── types.ts, registry.ts
│   └── code-fixer.ts
├── sessions/
│   ├── manager.ts
│   └── types.ts
├── tasks/       (保留)
├── skills/      (保留)
├── public/      (保留)
├── server.ts    (薄路由 + 组装)
├── db.ts        (扩展 schema)
├── env.ts       (保留)
└── index.ts     (保留)
```

## 迁移策略

不做大爆炸重构，逐步替换，每个 phase 结束后现有功能保持可用：

1. **Phase 1** — 定义接口 + EventBus + 目录结构搭建
2. **Phase 2** — 迁移 Sentry → SentryInputAdapter，Lark → LarkOutputAdapter
3. **Phase 3** — 重构 fault-healing workflow → code-fixer SubAgent + Executor
4. **Phase 4** — 重构 chat → SessionManager + WebChat adapters
5. **Phase 5** — 新增 Notion adapters + RuleRouter + OrchestratorAgent

## 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 架构模式 | Event Bus + Adapter | 解耦彻底，迁移路径清晰 |
| Core 决策方式 | 混合型（规则 + AI） | 常见场景快，复杂场景灵活 |
| EventBus 实现 | 内存同步 | 单进程部署，保持简单 |
| 会话存储 | 自管 messages 表 | 不绑定特定 LLM SDK，兼容所有 provider |
| 用户体系 | 直接用 Lark open_id | 100 人内部使用，不需要独立用户系统 |
| 迁移方式 | 分 5 个 phase 逐步替换 | 避免大爆炸重构，每步可验证 |
