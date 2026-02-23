# AI Hub 系统架构

## 设计理念

AI Hub 是一个 Web Chat 助手，通过 tools + skills 让 LLM Agent 自主完成任务。系统负责会话管理、用户记忆、审计日志和工具调度。

> **Fault Healing Pipeline 已移除**（2026-02-23）。原有的 Sentry webhook → Agent 自动修复流程已从代码中清理。复杂工作流编排计划迁移到 **n8n**，AI Hub 将暴露通用 `POST /api/agent` 端点供 n8n 调用。设计文档见 `docs/plans/2026-02-22-agent-api-design.md`。

---

## 目录结构

```
src/
├── core/           ← 事件审计（EventLog）
├── chat/           ← Chat 助手（SSE 流式、Provider、Auth、Compaction）
├── tools/          ← 统一工具定义（MCP + OpenAI 双格式）+ per-request 工具
├── skills/         ← 技能指令（Markdown + frontmatter）
├── sessions/       ← 会话管理
├── memory/         ← 用户记忆（FTS5 全文检索 + 写时去重）
├── public/         ← 前端静态页面
├── server.ts       ← 应用组装入口
├── env.ts          ← 环境变量（Zod 验证）
├── db.ts           ← SQLite 初始化 + Schema 迁移
└── index.ts        ← 入口（dotenv → startServer）
```

---

## core/ — 事件审计

| 文件 | 作用 |
|------|------|
| `hub-event.ts` | `HubEvent` 类型定义 — 系统内所有事件的统一结构（id, type, source, payload, metadata, context） |
| `event-bus.ts` | `EventLog` — 纯审计持久化，将事件写入 `event_log` 表，无 dispatch/订阅 |

---

## chat/ — Chat 助手

| 文件 | 作用 |
|------|------|
| `types.ts` | `ChatProvider` 接口、`ChatEvent` 联合类型（text / tool_use / tool_result / error / done）、`RequestTool` 类型 |
| `claude-provider.ts` | `ClaudeProvider` — 流式调用 Claude Agent SDK + MCP tools，支持 session resume |
| `generic-provider.ts` | `GenericProvider` — OpenAI 兼容 API（如 DeepSeek），自行管理多轮 tool calling 循环，含 token budget 跟踪和上下文压缩 |
| `setup.ts` | `setupChatProvider()` — 根据 env 配置选择 Provider，委托 `buildToolSuite()` 组装工具 |
| `router.ts` | `POST /api/chat` SSE 端点 — 会话管理、历史加载、记忆注入、per-request 工具注册、per-session 并发锁、流式响应 |
| `system-prompt.ts` | `buildSystemPrompt()` — 7 段式系统提示词（身份、安全、推理、工具使用、技能、项目知识、工具列表） |
| `auth.ts` | `chatAuthMiddleware()` — Bearer Token 验证，支持匿名模式 |
| `commands.ts` | 斜杠命令处理（/help, /reset, /list-skills 等） |
| `compaction.ts` | `compactHistory()` — 历史压缩 + 记忆提取，支持增量摘要合并和 token 级触发 |
| `token-utils.ts` | token 估算工具 |

### 请求链路

```
POST /api/chat
  │
  ├─ 1. 解析请求、Auth 校验
  ├─ 2. 创建/恢复 Session
  ├─ 3. 斜杠命令检查（/reset, /help 等）
  ├─ 4. Per-session 并发锁
  ├─ 5. 追加用户消息到 DB
  ├─ 6. 加载历史 + FTS5 检索相关 Memory
  ├─ 7. compactHistory（超限时增量摘要 + 记忆提取）
  ├─ 8. 注入 Memory + 注册 per-request 工具（memory_save / memory_delete）
  ├─ 9. provider.stream() ← 主要延迟（LLM API 调用 + tool calling 循环）
  ├─ 10. 保存助手回复 + provider session ID
  └─ 11. EventLog 审计（非阻塞）
```

---

## tools/ — 统一工具定义

| 文件 | 作用 |
|------|------|
| `types.ts` | `UnifiedToolDef` — 单一工具定义，同时驱动 MCP（Claude SDK）和 Generic（OpenAI）两种格式 |
| `register.ts` | `registerTool()` / `registerTools()` — 将 UnifiedToolDef 转为 MCP tool + Generic ToolDef + prompt 描述 |
| `suite.ts` | `buildToolSuite()` — 根据环境变量组装完整工具套件 |
| `memory-save.ts` | Per-request `memory_save` 工具 — 保存用户记忆 + FTS5 相似搜索去重提示 |
| `memory-delete.ts` | Per-request `memory_delete` 工具 — 删除记忆（含 userId 权限校验） |
| `sentry-query.ts` | 查询 Sentry API（issue 详情、最新事件、堆栈） |
| `bash-exec.ts` | 沙箱化 Shell 命令执行，超时/输出截断/命令白名单 |
| `web-fetch.ts` | HTTP 抓取 + HTML→Markdown 转换（Firecrawl 或内置），15分钟缓存 |
| `web-search.ts` | Brave Search API 搜索 |
| `claude-code.ts` | 委托任务给 Claude Code CLI（子 Agent 模式） |
| `file-tools.ts` | `file_read` + `file_write`，`safePath()` 沙箱校验防止路径逃逸 |
| `skill-reader.ts` | `get_skill` 工具 — 按需加载技能完整内容 |

### 工具分类

**静态工具**（启动时注册，所有请求共享）：

| 工具 | 启用条件 |
|------|---------|
| `get_skill`, `web_fetch`, `claude_code` | 始终启用 |
| `file_read`, `file_write` | 始终启用 |
| `sentry_query` | `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` |
| `web_search` | `BRAVE_API_KEY` |
| `bash_exec` | `BASH_EXEC_ENABLED=true` |

**Per-request 工具**（每次请求创建，携带 userId/sessionId 闭包）：

| 工具 | 说明 |
|------|------|
| `memory_save` | 保存记忆 + 返回相似记忆去重提示（FTS5 搜索） |
| `memory_delete` | 删除记忆，含 userId 权限校验 |

> Per-request 工具仅 GenericProvider 支持。ClaudeProvider 使用 MCP servers，暂不支持动态工具注入。

### 工具架构

```
buildToolSuite(env, skillsDir)
        │
        ├─→ mcpServers    ─→ ClaudeProvider（Claude Agent SDK）
        │
        ├─→ genericTools  ─→ GenericProvider（OpenAI 兼容 API）
        │                      + requestTools（memory_save, memory_delete）
        │
        └─→ descriptions  ─→ buildSystemPrompt()
```

---

## skills/ — 技能指令

Markdown 文件，带 YAML frontmatter（name, description, tags, allowed-tools）：

| 文件 | 用途 |
|------|------|
| `coding-agent.md` | 通用编码任务委托 |
| `review-pr.md` | PR 审查 |
| `github.md` | GitHub 操作 |
| `feishu-doc.md` / `notion.md` | 文档操作 |
| `summarize.md` / `weather.md` / `session-logs.md` | 其他辅助技能 |
| `frontmatter.ts` | `parseSkillFrontmatter()` — 解析 Markdown frontmatter |

**加载机制**: 启动时扫描所有 skill 的 name + description 注入 system prompt，运行时 Agent 通过 `get_skill` 工具按需加载完整内容。

---

## sessions/ + memory/ — 会话与记忆

| 文件 | 作用 |
|------|------|
| `sessions/manager.ts` | `SessionManager` — 会话 CRUD、消息追加、增量压缩（`compactMessages`）、provider session ID 绑定 |
| `sessions/types.ts` | `Session`、`Message` 类型定义 |
| `memory/manager.ts` | `MemoryManager` — 用户记忆 CRUD，FTS5 全文检索（CJK 前缀匹配），upsert on `(user_id, category, key)`，`removeByUser()` 权限删除 |
| `memory/types.ts` | `MemoryCategory`（preference / decision / fact / todo）、`MemoryItem`、`ExtractedMemory` 类型定义 |
| `memory/extractor.ts` | 从对话中提取结构化记忆，支持传入已有记忆让 LLM 复用 key |

### 记忆去重机制（Mem0-style 写时去重）

采用 Mem0 的写时增量去重思路，不做定期批量整理，零额外 LLM 调用：

1. **主动路径**（`memory_save` 工具）：保存后 FTS5 搜索相似记忆 → 返回去重提示 → LLM 自行调用 `memory_delete` 清理
2. **被动路径**（`extractMemories` 压缩时）：传入已有记忆列表 → 提示 LLM 复用已有 key → upsert 覆盖而非新建

```
用户说 "我叫张三"
  │
  ├─ LLM 调用 memory_save(category=fact, key=姓名, value=张三)
  │    │
  │    ├─ upsert (user_id, fact, 姓名)
  │    └─ FTS5 搜索 "姓名 张三" → 发现 id=5 [fact] name: Zhang San
  │         └─ 返回: "发现相似记忆: id=5 [fact] name: Zhang San, 如有重复请用 memory_delete 删除"
  │
  └─ LLM 调用 memory_delete(id=5, reason="与新记忆重复")
```

---

## 根目录核心文件

| 文件 | 作用 |
|------|------|
| `server.ts` | 应用组装入口 — 初始化 DB、EventLog、SessionManager、MemoryManager，构建工具套件，注册 Chat 路由 |
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
  ├─ buildToolSuite(env, skillsDir) — 工具套件
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
Web Chat ──→ router.ts ──→ provider.stream() ──→ SSE 响应
                │                │
          Session + Memory    EventLog 审计
                │
         memory_save / memory_delete (per-request tools)
```

---

## 数据库 Schema

```sql
-- 事件日志
event_log (id, type, source, payload, context, created_at)

-- 会话管理
sessions (id, user_id, channel, channel_id, provider, provider_session_id, status, created_at, last_active_at)

-- 消息历史
messages (id, session_id, role, content, tool_calls, created_at)

-- 用户记忆
memory (id, user_id, category, key, value, source_session_id, created_at, updated_at)
memory_fts (key, value)  -- FTS5 虚拟表，自动同步

-- 任务记录（遗留表，未来 Agent API 会复用）
tasks (id, sentry_issue_id, title, severity, status, pr_url, error, created_at, updated_at)
```

---

## 技术栈

- **Runtime:** Node.js 22+, ESM modules
- **Language:** TypeScript 5.9 (strict mode, NodeNext 模块解析)
- **Web framework:** Hono
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **AI:** Claude Agent SDK with MCP tools
- **Integrations:** Sentry (API query tool), GitHub (via `gh` CLI)
- **Validation:** Zod
- **Testing:** Vitest + in-memory SQLite

---

## API 端点

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/chat` | Auth 检查（轻量） |
| `POST` | `/api/chat` | Chat SSE 流式端点 |
| `GET` | `/*` | 静态前端 UI |

---

## 演进计划

| 阶段 | 内容 | 状态 |
|------|------|------|
| ~~Fault Healing Pipeline~~ | Sentry webhook → Agent 自动修复 | 已移除（2026-02-23），代码清理完成 |
| Agent API | `POST /api/agent` 通用端点 | 设计完成（见 plans/），待实现 |
| n8n 编排 | Sentry→分析→通知→审批→修复→PR | 待 Agent API 完成后接入 |
