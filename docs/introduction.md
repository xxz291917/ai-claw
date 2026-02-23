# AI Hub — 公司级 AI 助手平台

## 为什么做 AI Hub

2025 年起，大语言模型（LLM）从"能聊天"进化到"能干活"——能调用工具、读写文件、查询 API、执行代码。但在实际业务中，团队面临的痛点是：

- **碎片化**：每个人各自用 ChatGPT / Claude 网页版，提示词、工具链、最佳实践散落在个人设备上，无法沉淀和复用。
- **断联**：AI 和公司内部系统（Sentry、GitHub、飞书、Notion）之间没有打通，遇到问题还要手动复制粘贴。
- **无记忆**：每次对话从零开始，AI 不知道你的偏好、不了解项目上下文、不记得之前做过的决定。

AI Hub 要解决的就是这三个问题：**把 AI 能力统一到一个平台，连接公司内部系统，并让 AI 记住每个人。**

## AI Hub 是什么

AI Hub 是一个 **Web 端 AI 助手平台**，面向公司全员使用。核心特性：

| 能力 | 说明 |
|------|------|
| **多模型支持** | Claude（Agent SDK）和任意 OpenAI 兼容 API（DeepSeek 等），按需切换 |
| **工具系统** | 内置 web_fetch、web_search、bash_exec、file_read/write、sentry_query、claude_code 等工具，AI 可以直接操作 |
| **技能系统** | Markdown 格式定义的任务模板（review-pr、summarize、feishu-doc、notion 等），随时扩展 |
| **用户记忆** | FTS5 全文搜索 + 写时去重，AI 会记住每个用户的偏好、决定和关键信息 |
| **会话管理** | 多用户隔离、会话持久化、自动历史压缩（>40 轮时自动摘要） |
| **事件审计** | 所有交互记录到 EventLog，可追溯 |

### 技术栈

Node.js 22 + TypeScript 5.9 + Hono + SQLite（better-sqlite3，WAL 模式）+ Claude Agent SDK。轻量部署，一台服务器即可运行。

## 与 OpenClaw 的区别

AI Hub 的设计参考了 [OpenClaw](https://github.com/nicepkg/openclaw)，但定位和架构完全不同：

| 维度 | OpenClaw | AI Hub |
|------|----------|--------|
| **定位** | 个人 AI 助手，跑在自己设备上 | 公司级 AI 平台，统一部署 |
| **用户模型** | 单用户，一机一装 | 多用户，Token 认证，用户隔离 |
| **渠道** | 15+ 消息平台（WhatsApp/Telegram/Slack/iMessage 等） | Web 界面 + REST API + 飞书/企微（规划中） |
| **Agent 运行时** | Pi Agent RPC 模式，独立进程 | 内嵌 Claude Agent SDK / GenericProvider，零运维 |
| **记忆** | 会话级，无跨会话持久化 | FTS5 全文索引 + 用户级持久记忆 + 写时去重 |
| **工具扩展** | Workspace 插件包（npm 生态） | UnifiedToolDef 统一注册，同时驱动 MCP 和 OpenAI 格式 |
| **技能** | 内置 + 安装制 | Markdown 文件 + ClawHub 技能市场安装 |
| **部署** | 本地安装，launchd/systemd 守护进程 | Docker / 服务器部署，一行命令启动 |
| **复杂度** | 功能全面但重，适合极客 | 精简聚焦，适合团队快速上手 |

### 核心差异总结

1. **多用户 vs 单用户** — OpenClaw 是个人工具，AI Hub 是团队平台。每个用户有独立的会话和记忆空间。
2. **企业集成优先** — OpenClaw 侧重个人消息渠道（WhatsApp、iMessage 等），AI Hub 侧重公司内部系统对接（Sentry、GitHub、飞书、Notion、内部知识库等）。
3. **记忆架构** — AI Hub 的 FTS5 记忆系统支持跨会话持久化和语义检索，AI 能真正"记住"用户。
4. **技能生态** — 支持本地 Markdown 技能 + ClawHub 技能市场在线安装（`/install`），团队可共享和复用技能包。
5. **工作流编排** — 通过 Agent API 与 n8n / Dify 等平台对接，AI Hub 作为执行层嵌入企业自动化工作流。

## 当前内置技能

| 技能 | 用途 |
|------|------|
| `coding-agent` | 委派任务给 Claude Code / Codex CLI |
| `review-pr` | 结构化 PR 审查工作流 |
| `github` | GitHub CLI 操作（PR、Issue、CI） |
| `feishu-doc` | 飞书文档读写 |
| `notion` | Notion 页面 / 数据库操作 |
| `summarize` | 总结 URL、文件、YouTube 视频 |
| `session-logs` | 查询 AI Hub 自身的会话历史 |
| `memory-organizer` | 整理和清理用户记忆 |
| `weather` | 天气查询 |

## 未来方向

### 工作流编排

AI Hub 不是孤立的聊天工具，而是企业 AI 基础设施的执行层：

- **Agent API**（`POST /api/agent`）— 暴露通用 Agent 执行接口，外部系统可直接调用 AI 能力。
- **n8n / Dify 对接** — 作为工作流节点嵌入自动化流水线。典型场景：
  - Sentry 告警 → n8n 触发 → AI Hub 分析堆栈 + 定位代码 → 飞书通知相关开发
  - 定时任务 → AI Hub 生成周报 / 数据分析 → 推送到 Notion
  - PR 合并 → AI Hub 自动 review + 总结变更 → 发送到团队群

### 内部系统对接

- **内部知识库** — 对接公司 Wiki、Confluence、飞书知识库，让 AI 能基于公司私有文档回答问题。
- **更多渠道** — 飞书机器人、企业微信接入，让 AI 助手在团队日常沟通工具中直接可用。
- **内部工具链** — 数据库查询、Jenkins CI/CD、日志系统、监控平台等，按需接入为工具。

### 技能生态

- **ClawHub 技能市场** — 已支持 `/install <技能名>` 从 ClawHub 在线安装社区技能，`/search` 搜索可用技能。
- **团队技能共享** — `skills_extra/` 目录放置团队自定义技能，部署即生效，全员可用。
- **持续扩展** — 根据业务需求用 Markdown 快速编写新技能，零编码门槛。

### 权限与安全

- **角色权限** — 基于用户角色的工具授权，敏感操作（bash、文件写入）按级别控制。
- **审计追踪** — 所有操作记录到 EventLog，可追溯、可审计。

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量（复制 .env.example 后填写）
cp .env.example .env

# 开发模式
npm run dev

# 访问 http://localhost:8080
```

详细架构设计参见 [architecture.md](./architecture.md)。
