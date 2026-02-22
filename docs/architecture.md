# AI Hub 系统架构

## 设计理念

AI Hub 采用 **Agent 自治** 模式：LLM Agent 通过 tools + skills 自主完成完整工作流，不依赖预定义状态机或编排层。系统只负责触发、审计和结果记录。

复杂工作流编排（如 Sentry→分析→通知→修复→PR→CI/CD）计划迁移到 **n8n** 处理，AI Hub 通过 `POST /api/agent` 端点供 n8n 调用（尚未实现，见 `docs/plans/2026-02-22-agent-api-implementation.md`）。

## 目录结构

```
src/
├── core/           ← 事件审计（EventLog）
├── agent/          ← Claude SDK 执行引擎
├── tools/          ← 统一工具定义（MCP + OpenAI 双格式）
├── skills/         ← 技能指令（Markdown + frontmatter）
├── chat/           ← Chat 助手（SSE 流式）
├── routes/         ← Webhook 路由
├── lark/           ← 飞书通知
├── sessions/       ← 会话管理
├── memory/         ← 用户记忆（FTS5 全文检索）
└── public/         ← 前端静态页面
```

---

## core/ — 事件审计

| 文件 | 作用 |
|------|------|
| `hub-event.ts` | `HubEvent` 类型定义 — 系统内所有事件的统一结构（id, type, source, payload, metadata, context） |
| `event-bus.ts` | `EventLog` — 纯审计持久化，将事件写入 `event_log` 表，无 dispatch/订阅 |

`EventLog` 只有一个方法 `log(event)`，用于不可变审计追踪。

---

## agent/ — Claude SDK 执行引擎

| 文件 | 作用 |
|------|------|
| `runner.ts` | `runAgent()` — batch 模式调用 Claude Agent SDK `query()`，接受 `mcpServers` + `systemPrompt`，返回 `AgentResult`（text, sessionId, costUsd, error） |

Fault Healing 和 Chat 都依赖此引擎，区别在于调用模式：
- **Fault Healing**: batch 模式，fire-and-forget，结果写入 tasks 表
- **Chat (Claude)**: 流式模式，直接在 `ClaudeProvider` 中调用 `query()`

---

## tools/ — 统一工具定义

| 文件 | 作用 |
|------|------|
| `types.ts` | `UnifiedToolDef` — 单一工具定义，同时驱动 MCP（Claude SDK）和 Generic（OpenAI）两种格式 |
| `register.ts` | `registerTool()` / `registerTools()` — 将 UnifiedToolDef 转为 MCP tool + Generic ToolDef + prompt 描述 |
| `suite.ts` | `buildToolSuite()` — 根据环境变量组装完整工具套件，Chat 和 Fault Healing 共享 |
| `sentry-query.ts` | 查询 Sentry API（issue 详情、最新事件、堆栈） |
| `bash-exec.ts` | 沙箱化 Shell 命令执行，超时/输出截断/命令白名单 |
| `web-fetch.ts` | HTTP 抓取 + HTML→Markdown 转换（Firecrawl 或内置），15分钟缓存 |
| `web-search.ts` | Brave Search API 搜索 |
| `claude-code.ts` | 委托任务给 Claude Code CLI（子 Agent 模式） |
| `file-tools.ts` | `file_read` + `file_write`，`safePath()` 沙箱校验防止路径逃逸 |
| `skill-reader.ts` | `get_skill` 工具 — 按需加载技能完整内容 |

### 工具共享架构

Chat 和 Fault Healing 共享同一套工具基础设施：

```
buildToolSuite(env, skillsDir)
        │
        ├─→ mcpServers    ─→ ClaudeProvider (Chat 流式)
        │                 ─→ runAgent()     (Fault Healing batch)
        │
        ├─→ genericTools  ─→ GenericProvider (OpenAI 兼容 API)
        │
        └─→ descriptions  ─→ buildSystemPrompt() (Chat)
                          ─→ fhSystemPrompt      (Fault Healing skill + 工具描述)
```

### 工具条件加载

| 工具 | 启用条件 |
|------|---------|
| `get_skill`, `web_fetch`, `claude_code` | 始终启用 |
| `sentry_query` | `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` |
| `web_search` | `BRAVE_API_KEY` |
| `bash_exec` | `BASH_EXEC_ENABLED=true` |

---

## skills/ — 技能指令

Markdown 文件，带 YAML frontmatter（name, description, tags, allowed-tools）：

| 文件 | 用途 |
|------|------|
| `fault-healing.md` | 故障修复：分析 + 修复的完整指令 |
| `coding-agent.md` | 通用编码任务委托 |
| `review-pr.md` | PR 审查 |
| `github.md` | GitHub 操作 |
| `feishu-doc.md` / `notion.md` | 文档操作 |
| `summarize.md` / `weather.md` / `session-logs.md` | 其他辅助技能 |
| `frontmatter.ts` | `parseSkillFrontmatter()` — 解析 Markdown frontmatter |

**加载机制**: 启动时扫描所有 skill 的 name + description 注入 system prompt，运行时 Agent 通过 `get_skill` 工具按需加载完整内容。

---

## chat/ — Chat 助手

| 文件 | 作用 |
|------|------|
| `types.ts` | `ChatProvider` 接口、`ChatEvent` 联合类型（text / tool_use / tool_result / error / done） |
| `claude-provider.ts` | `ClaudeProvider` — 流式调用 Claude Agent SDK + MCP tools，支持 session resume |
| `generic-provider.ts` | `GenericProvider` — OpenAI 兼容 API（如 DeepSeek），自行管理多轮 tool calling 循环，含 token budget 跟踪和上下文压缩 |
| `setup.ts` | `setupChatProvider()` — 根据 env 配置选择 Provider，委托 `buildToolSuite()` 组装工具 |
| `router.ts` | `POST /api/chat` SSE 端点 — 会话管理、历史加载、记忆注入、per-session 并发锁、流式响应 |
| `system-prompt.ts` | `buildSystemPrompt()` — 7 段式系统提示词（身份、安全、推理、工具使用、技能、项目知识、工具列表） |
| `auth.ts` | `chatAuthMiddleware()` — Bearer Token 验证，支持匿名模式 |
| `commands.ts` | 斜杠命令处理（/help, /reset, /list-skills 等） |
| `compaction.ts` | `compactHistory()` — 超过 40 条历史时触发摘要压缩 + 记忆提取 |

### 请求链路

```
POST /api/chat
  │
  ├─ 1. 解析请求、Auth 校验
  ├─ 2. 创建/恢复 Session
  ├─ 3. 斜杠命令检查（/reset, /help 等）
  ├─ 4. Per-session 并发锁
  ├─ 5. 追加用户消息到 DB
  ├─ 6. 加载历史 + 注入 Memory（FTS5 检索）
  ├─ 7. compactHistory（>40 条时摘要压缩）
  ├─ 8. provider.stream() ← 主要延迟在这里（LLM API 调用）
  ├─ 9. 保存助手回复 + provider session ID
  └─ 10. EventLog 审计（非阻塞）
```

---

## routes/ — Webhook 路由

| 文件 | 作用 |
|------|------|
| `webhooks.ts` | `POST /webhooks/sentry` — Zod 校验 payload、issue 去重、建任务、EventLog 审计、fire-and-forget 调用 Agent |

### Fault Healing 流程（Agent 自治）

```
Sentry Webhook
  │
  ├─ Zod 校验 payload
  ├─ 去重检查（同 issue 已有 running 任务则跳过）
  ├─ 创建 task 记录（status = running）
  ├─ EventLog 审计
  └─ Fire-and-forget:
       runAgent(prompt, config)
         ├─ 成功 → task.status = done
         └─ 失败 → task.status = failed, task.error = message
```

task 状态只有 3 种：`running` / `done` / `failed`

---

## lark/ — 飞书通知

| 文件 | 作用 |
|------|------|
| `notify.ts` | `buildNotificationCard()` — 构建信息通知卡片（非交互式），`sendLarkCard()` — 发送到飞书群 |

飞书卡片为纯通知用途（标题、正文、可选链接按钮），不包含审批/操作按钮。

---

## sessions/ + memory/ — 会话与记忆

| 文件 | 作用 |
|------|------|
| `sessions/manager.ts` | `SessionManager` — 会话 CRUD、消息追加、provider session ID 绑定 |
| `sessions/types.ts` | `Session`、`Message` 类型定义 |
| `memory/manager.ts` | `MemoryManager` — 用户记忆存储，FTS5 全文检索（CJK 前缀匹配），每次请求动态注入相关记忆 |
| `memory/types.ts` | `MemoryCategory`、`MemoryItem`、`ExtractedMemory` 类型定义 |
| `memory/extractor.ts` | 从对话中提取结构化记忆（偏好、决策、事实），依赖 Provider 的 `summarize()` 能力 |

---

## 根目录核心文件

| 文件 | 作用 |
|------|------|
| `server.ts` | 应用组装入口 — 初始化 DB、EventLog、SessionManager、MemoryManager，构建共享工具套件，条件启用 Fault Healing，注册 Chat 路由 |
| `env.ts` | Zod 验证的环境变量配置（带缓存单例，测试用 `setEnv()`） |
| `db.ts` | SQLite 初始化（WAL 模式），建表 + schema 迁移 |
| `index.ts` | 入口文件，加载 dotenv → `startServer()` |

### server.ts 初始化流程

```
createApp()
  │
  ├─ loadEnv() — Zod 校验环境变量
  ├─ createDb() — SQLite 初始化 + schema 迁移
  ├─ new EventLog(db)
  ├─ new SessionManager(db)
  ├─ new MemoryManager(db)
  │
  ├─ chatAuthMiddleware() — 注册 Auth 中间件
  ├─ buildToolSuite(env, skillsDir) — 共享工具套件
  │
  ├─ [条件] Fault Healing Pipeline
  │    ├─ 需要: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, ANTHROPIC_API_KEY, GH_TOKEN
  │    ├─ 加载 fault-healing.md skill
  │    └─ registerWebhookRoutes(app, { db, eventLog, runFaultHealing })
  │
  ├─ Chat Assistant
  │    ├─ setupChatProvider(env, skillsDir, toolSuite)
  │    └─ chatRouter(app, provider, { sessionManager, eventLog, memoryManager })
  │
  └─ serveStatic() — 前端 UI
```

---

## 整体数据流

```
                    ┌─ Sentry Webhook ──→ webhooks.ts ──→ runAgent() (fire-and-forget)
                    │                         │                 │
外部输入 ───────────┤                   EventLog 审计      tasks 表更新
                    │
                    └─ Web Chat ────────→ router.ts ──→ provider.stream() ──→ SSE 响应
                                              │                │
                                        Session + Memory    EventLog 审计
```

---

## 数据库 Schema

```sql
-- 任务记录（Fault Healing）
tasks (id, sentry_issue_id, title, severity, status, pr_url, error, created_at, updated_at)
  -- status: running | done | failed

-- 审计日志
audit_log (id, task_id, action, detail, created_at)

-- 事件日志
event_log (id, type, source, payload, context, created_at)

-- 会话管理
sessions (id, user_id, channel, channel_id, provider, provider_session_id, status, created_at, last_active_at)

-- 消息历史
messages (id, session_id, role, content, tool_calls, created_at)

-- 用户记忆
memory (id, user_id, category, key, value, source_session_id, created_at, updated_at)
memory_fts (key, value)  -- FTS5 虚拟表，自动同步
```

---

## 技术栈

- **Runtime:** Node.js 22+, ESM modules
- **Language:** TypeScript 5.9 (strict mode, NodeNext 模块解析)
- **Web framework:** Hono
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **AI:** Claude Agent SDK with MCP tools
- **Integrations:** Sentry (webhooks + API), Lark/飞书 (通知卡片), GitHub (via `gh` CLI)
- **Validation:** Zod
- **Testing:** Vitest + in-memory SQLite

---

## API 端点

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/tasks/:id` | 查询任务状态 |
| `POST` | `/api/chat` | Chat SSE 流式端点 |
| `POST` | `/webhooks/sentry` | Sentry 告警 Webhook |
| `GET` | `/*` | 静态前端 UI |
