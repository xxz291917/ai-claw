# AI Hub 系统架构

## 目录结构

```
src/
├── core/           ← 事件驱动核心
├── adapters/       ← 输入/输出适配器
├── routes/         ← 路由规则
├── agents/         ← SubAgent 接口层
├── workflows/      ← 业务流程层
├── agent/          ← Claude SDK 执行引擎
├── tools/          ← 统一工具定义
├── skills/         ← 技能指令(Markdown)
├── chat/           ← Chat 助手
├── tasks/          ← 任务状态机
├── lark/           ← 飞书集成
├── webhooks/       ← 旧版 Webhook(遗留)
├── sessions/       ← 会话管理
├── memory/         ← 用户记忆
└── public/         ← 前端静态页面
```

---

## core/ — 事件驱动核心

| 文件 | 作用 |
|------|------|
| `hub-event.ts` | `HubEvent` 类型定义 — 系统内所有事件的统一结构（id, type, source, payload, context） |
| `event-bus.ts` | `EventBus` — 进程内发布订阅，事件持久化到 `event_log` 表，支持通配符模式匹配 |
| `rule-router.ts` | `RuleRouter` — 将事件匹配到路由规则，生成 `TaskPlan`（指定 agent + skill + inputs） |
| `executor.ts` | `Executor` — 接收 TaskPlan，从 Registry 获取 Agent，执行并记录到 `audit_log` |
| `core.ts` | `Core` — 总调度：`chat.*` 事件走 handleChat，其余走 RuleRouter → Executor |

**事件流**: EventBus → Core → RuleRouter → Executor → SubAgent

---

## adapters/ — 输入/输出适配器

### input/ — 将外部原始数据转换为 HubEvent

| 文件 | 事件类型 |
|------|---------|
| `sentry.ts` | Sentry payload → `sentry.issue_alert` |
| `lark.ts` | 飞书回调 → `lark.card_action` / `chat.lark_p2p` / `chat.lark_group` |
| `web-chat.ts` | Web 聊天请求 → `chat.web` |
| `types.ts` | `InputAdapter` 接口定义 |

### output/ — 将 Agent 结果发送到外部系统

| 文件 | 作用 |
|------|------|
| `types.ts` | `OutputAction` 联合类型、`OutputAdapter` 接口、`OutputBus` 类 |
| `lark.ts` | 飞书通知输出适配器 |

---

## routes/ — 事件路由规则

| 文件 | 作用 |
|------|------|
| `webhooks.ts` | 注册 `POST /webhooks/sentry` 和 `POST /callbacks/lark`，去重 → 建任务 → 发射事件到 EventBus |
| `fault-healing.ts` | 路由规则数组：`sentry.issue_alert` → analysis skill，`lark.card_action` → action skill |

---

## agents/ — SubAgent 接口层（适配器）

| 文件 | 作用 |
|------|------|
| `types.ts` | `SubAgent` 接口、`AgentEvent` 联合类型（thinking / tool_call / tool_result / result / error）、`TaskExecution` |
| `registry.ts` | `AgentRegistry` — Agent 注册表，name → SubAgent 映射 |
| `fault-healing.ts` | `FaultHealingAgent` — 根据 `task.skill` 分发到 workflow 的 `runAnalysis()` 或 `handleAction()` |

---

## workflows/ — 业务流程层

| 文件 | 作用 |
|------|------|
| `fault-healing.ts` | `FaultHealingWorkflow` — 两阶段流程：分析（pending→analyzing→reported）+ 修复（reported→fixing→pr_ready），依赖注入 `runAgent`、`sendLarkCard` |

**agents/ vs workflows/ 的区别**：agents/ 是 EventBus 架构的接口适配，workflows/ 是实际执行业务逻辑。调用链：`Executor → FaultHealingAgent.execute() → FaultHealingWorkflow.runAnalysis()`

---

## agent/ — Claude SDK 执行引擎

| 文件 | 作用 |
|------|------|
| `runner.ts` | `runAgent()` — batch 模式调用 Claude Agent SDK `query()`，接受预构建的 `mcpServers`，收集最终结果返回 `AgentResult` |

---

## tools/ — 统一工具定义

| 文件 | 作用 |
|------|------|
| `types.ts` | `UnifiedToolDef` — 单一工具定义，同时驱动 MCP（Claude SDK）和 Generic（OpenAI）两种格式 |
| `register.ts` | `registerTool()` / `registerTools()` — 将 UnifiedToolDef 转为 MCP tool + Generic ToolDef + prompt 描述 |
| `suite.ts` | `buildToolSuite()` — 根据环境变量组装完整工具套件，Chat 和 Fault Healing 共享 |
| `sentry-query.ts` | 查询 Sentry API（issue 详情、最新事件、堆栈） |
| `bash-exec.ts` | 沙箱化 Shell 命令执行，超时/输出截断/命令白名单 |
| `web-fetch.ts` | HTTP 抓取 + HTML→Markdown 转换，15分钟缓存 |
| `web-search.ts` | Brave Search API 搜索 |
| `claude-code.ts` | 委托任务给 Claude Code CLI（子 Agent 模式） |
| `file-tools.ts` | 文件读写，`safePath()` 沙箱校验防止路径逃逸 |
| `skill-reader.ts` | `get_skill` 工具 — 按需加载技能完整内容 |

---

## skills/ — 技能指令

Markdown 文件，带 YAML frontmatter（name, description, allowed-tools）：

| 文件 | 用途 |
|------|------|
| `fault-healing.md` | 故障修复：分析阶段 + 修复阶段的完整指令 |
| `coding-agent.md` | 通用编码任务 |
| `review-pr.md` | PR 审查 |
| `github.md` | GitHub 操作 |
| `feishu-doc.md` / `notion.md` | 文档操作 |
| `summarize.md` / `weather.md` / `session-logs.md` | 其他辅助技能 |
| `frontmatter.ts` | `parseSkillFrontmatter()` — 解析 Markdown frontmatter |

**加载机制**: 启动时扫描摘要注入 system prompt，运行时通过 `get_skill` 工具按需加载完整内容。

---

## chat/ — Chat 助手

| 文件 | 作用 |
|------|------|
| `types.ts` | `ChatProvider` 接口、`ChatEvent` 联合类型（text / tool_use / tool_result / error / done） |
| `claude-provider.ts` | `ClaudeProvider` — 流式调用 Claude Agent SDK + MCP tools |
| `generic-provider.ts` | `GenericProvider` — OpenAI 兼容 API（如 DeepSeek），自行管理多轮 tool calling 循环 |
| `setup.ts` | `setupChatProvider()` — 根据 env 配置选择 Provider，委托 `buildToolSuite()` 组装工具 |
| `router.ts` | `POST /api/chat` SSE 端点 — 会话管理、历史加载、记忆注入、流式响应 |
| `system-prompt.ts` | `buildSystemPrompt()` — 7 段式系统提示词（身份、安全、推理、工具、技能、项目知识、工具列表） |
| `auth.ts` | `chatAuthMiddleware()` — Bearer Token 验证，支持匿名模式 |
| `commands.ts` | 聊天命令处理（/help, /clear, /status 等） |
| `compaction.ts` | `compactHistory()` — 历史消息压缩，保持 token 预算内 |

---

## tasks/ — 任务状态机

| 文件 | 作用 |
|------|------|
| `types.ts` | 状态机定义 |
| `store.ts` | `TaskStore` — SQLite CRUD，状态转换校验，审计日志 |

**状态流转**:

```
pending → analyzing → reported → fixing → pr_ready → merged → done
              ↓            ↓         ↓         ↓
            failed      ignored    failed    rejected
```

---

## lark/ — 飞书集成

| 文件 | 作用 |
|------|------|
| `notify.ts` | `buildDiagnosisCard()` / `buildPrReadyCard()` / `sendLarkCard()` — 构建和发送交互式飞书卡片 |
| `callback.ts` | `larkCallback()` — 处理飞书卡片按钮回调（fix/merge/ignore/reject） |

---

## sessions/ + memory/ — 会话与记忆

| 文件 | 作用 |
|------|------|
| `sessions/manager.ts` | `SessionManager` — 会话 CRUD、消息追加、多轮对话管理 |
| `sessions/types.ts` | `Session`、`Message` 类型定义 |
| `memory/manager.ts` | `MemoryManager` — 用户记忆存储，FTS5 全文检索，每次请求动态注入相关记忆 |
| `memory/types.ts` | `MemoryCategory`、`MemoryItem`、`ExtractedMemory` 类型定义 |
| `memory/extractor.ts` | 从对话中提取结构化记忆（偏好、决策、事实） |

---

## 根目录核心文件

| 文件 | 作用 |
|------|------|
| `server.ts` | 应用组装入口 — 初始化所有组件、注册路由、构建共享工具套件 |
| `env.ts` | Zod 验证的环境变量配置 |
| `db.ts` | SQLite 初始化（WAL 模式），建表语句 |
| `index.ts` | 入口文件，加载 dotenv → `startServer()` |

---

## 整体数据流

```
外部事件                     核心管道                          输出
─────────────────────────────────────────────────────────────────────
Sentry Webhook ──┐
飞书消息/按钮 ───┤→ InputAdapter → HubEvent → EventBus
Web Chat ────────┘                              │
                                                ↓
                                    Core.handle(event)
                                     ├─ chat.* → ChatRouter → Provider → SSE
                                     └─ 其他   → RuleRouter → TaskPlan
                                                               ↓
                                                    Executor → SubAgent.execute()
                                                               ↓
                                                    FaultHealingAgent
                                                               ↓
                                                    FaultHealingWorkflow
                                                     ├─ runAgent() → Claude SDK
                                                     └─ sendLarkCard() → 飞书
```

## 工具共享架构

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

## 技术栈

- **Runtime:** Node.js 22+, ESM modules
- **Language:** TypeScript 5.9 (strict mode)
- **Web framework:** Hono
- **Database:** SQLite via better-sqlite3 (WAL mode)
- **AI:** Claude Agent SDK with MCP tools
- **Integrations:** Sentry (webhooks + API), Lark/飞书 (cards + callbacks), GitHub (via `gh` CLI)
- **Validation:** Zod
- **Testing:** Vitest
