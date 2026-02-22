# Agent API + n8n 编排设计

## 背景

AI Hub 当前包含 Sentry fault-healing 的 webhook 处理和 fire-and-forget Agent 调用。随着 workflow 需求增长（Sentry 修复流程需要中间通知和人工审批卡点，未来还有 Notion 触发等），编排逻辑会越来越复杂。

经评估，选择将编排职责交给 n8n，AI Hub 退化为**通用 Agent API + Chat 助手**，不做业务编排。

## 架构决策

- **AI Hub**：通用 Agent 执行层 — 暴露 `POST /api/agent` 端点，接收 prompt + 可选 skill，调用 Claude Agent SDK 执行，返回结果
- **n8n**：编排层 — 处理触发（Sentry webhook）、步骤串联、飞书通知、人工审批、重试和超时
- **关系**：n8n 通过 HTTP Request node 调用 AI Hub 的 Agent API，AI Hub 完全不感知 workflow 逻辑

```
                n8n (编排层)                          AI Hub (Agent 层)
        ┌──────────────────────┐              ┌──────────────────────┐
        │                      │              │                      │
Sentry ─→ Sentry Trigger      │              │  POST /api/agent     │
        │       │              │   HTTP call  │    ├─ prompt          │
        │       ▼              │ ──────────→  │    ├─ skill (可选)    │
        │  Agent: 分析         │              │    └─ tools + SDK     │
        │       │              │  ←────────── │         │             │
        │       ▼              │   AgentResult│    AgentResult        │
        │  飞书通知: 诊断      │              │                      │
        │       │              │              │  POST /api/chat      │
        │       ▼              │              │    (不变)             │
        │  Wait: 人工审批      │              │                      │
        │       │              │              │  GET /health          │
        │       ▼              │              │                      │
        │  Agent: 修复   ──────│──→ 同上      │                      │
        │       │              │              │                      │
        │       ▼              │              └──────────────────────┘
        │  飞书通知: PR 链接   │
        │                      │
        └──────────────────────┘
```

## Provider 双模式设计

`ChatProvider` 接口新增 `run()` 方法，`stream()` 给 Chat（人用），`run()` 给 Agent API（机器用）：

```typescript
interface ChatProvider {
  name: string;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;  // Chat SSE 用
  run?(req: ChatRequest): Promise<AgentResult>;         // Agent API 用
}
```

两个 Provider 各自实现最优方式：

| Provider | `stream()` | `run()` |
|----------|-----------|---------|
| ClaudeProvider | `query()` + yield 流事件 | `query()` 收集最终结果（真正 batch 模式） |
| GenericProvider | OpenAI streaming + yield | 内部消费 `stream()` 收集结果返回 |

Agent API 端点调用 `provider.run()`：

```typescript
app.post("/api/agent", async (c) => {
  const { prompt, skill } = await c.req.json();
  const result = await provider.run({ message: prompt, history: [] });
  return c.json(result);
});
```

`CHAT_PROVIDER=generic` 时 Agent API 自动走 GenericProvider（如 DeepSeek），无需额外配置。

## Agent API 端点设计

### `POST /api/agent`

请求：

```json
{
  "prompt": "分析 Sentry issue #123: TypeError: Cannot read property...",
  "skill": "coding-agent",
  "context": {
    "sentry_issue_id": "123",
    "previous_step_result": "Root cause is..."
  },
  "config": {
    "maxTurns": 20,
    "maxBudgetUsd": 1.0
  }
}
```

| 字段 | 必须 | 说明 |
|------|------|------|
| `prompt` | 是 | Agent 任务描述 |
| `skill` | 否 | Skill 名称，注入为 system prompt |
| `context` | 否 | 键值对，以 `## Context` 块附加到 prompt 末尾 |
| `config.maxTurns` | 否 | 最大轮次，默认 30 |
| `config.maxBudgetUsd` | 否 | 最大预算，默认 2.0 |

响应（同步，等 Agent 完成）：

```json
{
  "id": "uuid",
  "status": "done",
  "text": "分析完成。Root cause: ...",
  "costUsd": 0.35,
  "error": null
}
```

失败时：

```json
{
  "id": "uuid",
  "status": "failed",
  "text": "",
  "costUsd": 0.12,
  "error": "Agent run failed: max turns exceeded"
}
```

Auth：复用 `chatAuthMiddleware`（Bearer token），n8n 在 HTTP Request node 的 Header 里传 token。

### `GET /api/agent/:id`

查询历史执行记录。响应格式同上。

## DB Schema 变化

删除 `tasks` 表，新建 `agent_runs`：

```sql
CREATE TABLE agent_runs (
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

CREATE INDEX idx_agent_runs_status ON agent_runs(status);
```

同时删除 `tasks` 表相关的索引（`idx_tasks_sentry_issue`, `idx_tasks_status`）和迁移代码。

## 文件变化清单

### 删除

| 文件 | 原因 |
|------|------|
| `src/routes/webhooks.ts` | Sentry webhook 迁移到 n8n |
| `src/skills/fault-healing.md` | Sentry 专属 skill，迁移到 n8n prompt |
| `test/webhooks/sentry.test.ts` | 对应测试 |

### 新增

| 文件 | 作用 |
|------|------|
| `src/routes/agent.ts` | `POST /api/agent` + `GET /api/agent/:id` |
| `test/routes/agent.test.ts` | 对应测试 |

### 修改

| 文件 | 变化 |
|------|------|
| `src/chat/types.ts` | `ChatProvider` 接口新增 `run?()` 方法 |
| `src/chat/claude-provider.ts` | 新增 `run()` — batch 模式（复用 `runAgent()` 逻辑） |
| `src/chat/generic-provider.ts` | 新增 `run()` — 内部消费 `stream()` 收集结果 |
| `src/server.ts` | 移除 fault-healing 初始化块 (L58-82)，注册 agent routes |
| `src/db.ts` | `tasks` 表 → `agent_runs` 表，删除旧迁移代码 |

### 保留不变

| 文件 | 说明 |
|------|------|
| `src/lark/notify.ts` | 保留，未来可能有其他通知场景 |
| `src/chat/*` | Chat 助手全部不变 |
| `src/tools/*` | 全部工具不变，n8n 通过 Agent API 间接使用 |
| `src/skills/*` (除 fault-healing.md) | 通用 skill 保留 |
| `src/agent/runner.ts` | Agent 执行引擎不变，ClaudeProvider.run() 内部调用 |
| `src/core/*` | EventLog 审计不变 |
| `src/sessions/*`, `src/memory/*` | 会话和记忆不变 |

## server.ts 改造后的初始化流程

```
createApp()
  ├─ loadEnv()
  ├─ createDb()  (agent_runs 替代 tasks)
  ├─ EventLog, SessionManager, MemoryManager
  ├─ chatAuthMiddleware()
  ├─ buildToolSuite(env, skillsDir)
  │
  ├─ Agent API
  │    └─ registerAgentRoutes(app, { db, eventLog, toolSuite, env })
  │
  ├─ Chat Assistant
  │    └─ chatRouter(app, provider, { sessionManager, eventLog, memoryManager })
  │
  └─ serveStatic()
```

## n8n 侧参考（不属于 AI Hub 改造范围）

n8n 自托管部署后，创建 Sentry 修复 workflow：

1. **Sentry Trigger** — n8n 内置 Sentry node 接收 webhook
2. **HTTP Request: 分析** — POST `ai-hub/api/agent`，prompt 包含 issue 详情，skill 指定 `coding-agent`
3. **Lark: 诊断通知** — n8n HTTP node 调飞书 API 发送卡片
4. **Wait: 人工审批** — n8n Wait node + webhook callback
5. **IF: 批准？** — 条件分支
6. **HTTP Request: 修复** — POST `ai-hub/api/agent`，prompt 包含诊断结果 + 修复指令
7. **Lark: PR 通知** — 发送 PR 链接

审批、超时、重试、通知全部由 n8n 处理，AI Hub 不感知。
