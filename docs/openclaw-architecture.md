# OpenClaw 项目架构全景文档

> 版本: 2026.2.9 | 最后更新: 2026-02-13

## 1. 项目概览

**OpenClaw** 是一个 **个人 AI 助理平台**，用户可在自己的设备上运行。它通过统一的 Gateway 控制面将 AI 能力接入到多个消息平台（WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage、Microsoft Teams、Matrix、Zalo、WebChat 等），同时支持 macOS/iOS/Android 客户端。

核心定位：**单用户、本地优先、永远在线的 AI 助理**。

```
技术栈:
├── 语言: TypeScript (ESM, strict mode)
├── 运行时: Node.js ≥22 (Bun 可选用于开发)
├── 包管理: pnpm (monorepo workspace)
├── 构建: tsdown (基于 Rolldown)
├── 测试: Vitest + V8 coverage (70% 阈值)
├── Lint: Oxlint + Oxfmt
├── AI Agent: Pi Agent Runtime (@mariozechner/pi-agent-core)
└── 部署: npm 全局安装 / Docker / Nix / macOS App
```

---

## 2. 高层架构图

```
┌──────────────────────────────────────────────────────────────────────┐
│                        消息平台 (Channels)                           │
│  WhatsApp  Telegram  Slack  Discord  Signal  iMessage  Teams  ...   │
└───────┬────────┬───────┬──────┬───────┬────────┬──────┬─────────────┘
        │        │       │      │       │        │      │
        ▼        ▼       ▼      ▼       ▼        ▼      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Channel Adapters (插件化)                          │
│          每个 Channel 实现标准的 ChannelPlugin 接口                    │
│     (Inbound Monitor → Message Normalize → Outbound Deliver)        │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      Gateway (控制面)                                │
│                  ws://127.0.0.1:18789 (默认)                        │
│                                                                      │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ 路由引擎 │  │ 会话管理  │  │ 插件注册  │  │ 配置管理  │             │
│  │ Routing  │  │ Sessions │  │ Plugins  │  │ Config   │             │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘             │
│       │            │             │              │                     │
│  ┌────┴────────────┴─────────────┴──────────────┴──────┐             │
│  │               WebSocket RPC 方法层                    │             │
│  │  chat.* | agent.* | sessions.* | channels.*         │             │
│  │  send | health | models.* | skills.* | cron.*       │             │
│  │  nodes.* | browser.* | canvas.* | voicewake.*       │             │
│  └─────────────────────┬───────────────────────────────┘             │
│                        │                                              │
│  ┌─────────┐  ┌───────┴────┐  ┌──────────┐  ┌──────────┐           │
│  │ Cron    │  │ HTTP Server │  │ Control  │  │ Canvas   │           │
│  │ Service │  │ (Express/   │  │ UI       │  │ Host     │           │
│  │         │  │  Hono)      │  │ (Web)    │  │ (A2UI)   │           │
│  └─────────┘  └────────────┘  └──────────┘  └──────────┘           │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Pi Agent Runtime (AI 引擎)                        │
│                                                                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ 模型选择  │  │ Auth 轮换  │  │ System   │  │ Tool Execution   │   │
│  │ & 降级   │  │ & Failover│  │ Prompt   │  │ (bash/browser/   │   │
│  │          │  │           │  │ Builder  │  │  canvas/skills)  │   │
│  └──────────┘  └───────────┘  └──────────┘  └──────────────────┘   │
│                                                                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ 流式响应  │  │ Session   │  │ Memory   │  │ Subagent         │   │
│  │ Streaming│  │ Compaction│  │ Search   │  │ Spawning         │   │
│  └──────────┘  └───────────┘  └──────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      客户端 & 节点 (Nodes)                           │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ macOS    │  │ iOS Node │  │ Android  │  │ WebChat  │            │
│  │ Menu Bar │  │          │  │ Node     │  │ UI       │            │
│  │ App      │  │ Camera/  │  │ Camera/  │  │          │            │
│  │ + Voice  │  │ Canvas/  │  │ Canvas/  │  │          │            │
│  │   Wake   │  │ Voice    │  │ Screen   │  │          │            │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. 目录结构

```
openclaw/
├── src/                    # 核心源码
│   ├── entry.ts            # CLI 入口（Node 进程启动）
│   ├── index.ts            # 库入口 + Commander CLI 程序
│   ├── cli/                # CLI 命令层 (commander)
│   ├── commands/           # CLI 命令实现
│   ├── gateway/            # Gateway 服务端 (WebSocket + HTTP)
│   ├── agents/             # AI Agent 系统（核心）
│   ├── channels/           # Channel 注册表 + 通用逻辑
│   ├── routing/            # 消息路由引擎
│   ├── sessions/           # 会话管理
│   ├── config/             # 配置加载 + 校验 (Zod)
│   ├── plugins/            # 插件加载器 + 注册表
│   ├── plugin-sdk/         # 插件开发 SDK (导出类型)
│   ├── infra/              # 基础设施 (端口/错误/二进制/事件)
│   ├── media/              # 媒体处理管线 (图片/音频/视频)
│   ├── hooks/              # 内部钩子 + 外部钩子 (Gmail etc.)
│   ├── telegram/           # Telegram 适配器 (grammY)
│   ├── discord/            # Discord 适配器 (discord.js/Carbon)
│   ├── slack/              # Slack 适配器 (Bolt)
│   ├── whatsapp/           # WhatsApp 适配器 (Baileys)
│   ├── signal/             # Signal 适配器 (signal-cli)
│   ├── imessage/           # iMessage 适配器
│   ├── web/                # WhatsApp Web + auto-reply 核心
│   ├── browser/            # 浏览器控制 (Playwright)
│   ├── canvas-host/        # Canvas/A2UI 宿主
│   ├── tts/                # 文本转语音
│   ├── cron/               # 定时任务
│   ├── memory/             # 记忆搜索
│   ├── tui/                # 终端 UI
│   ├── wizard/             # 引导向导 (onboarding)
│   ├── logging/            # 结构化日志
│   ├── process/            # 子进程管理 (exec/pty)
│   ├── security/           # 安全策略
│   ├── providers/          # LLM 提供者适配 (Copilot/Gemini etc.)
│   └── terminal/           # 终端输出 (表格/调色板)
├── extensions/             # 扩展插件 (独立 workspace 包)
│   ├── msteams/            # Microsoft Teams
│   ├── matrix/             # Matrix
│   ├── zalo/               # Zalo
│   ├── telegram/           # Telegram 扩展
│   ├── discord/            # Discord 扩展
│   ├── slack/              # Slack 扩展
│   ├── voice-call/         # 语音通话
│   ├── memory-core/        # 记忆核心
│   ├── memory-lancedb/     # LanceDB 记忆
│   ├── talk-voice/         # Talk Mode 语音
│   └── ...                 # 30+ 个扩展
├── apps/                   # 原生应用
│   ├── macos/              # macOS SwiftUI App
│   ├── ios/                # iOS SwiftUI App
│   └── android/            # Android Kotlin App
├── ui/                     # Web UI (Control UI + WebChat)
│   └── src/                # Vite + Lit 组件
├── skills/                 # 内置 Skills
├── docs/                   # Mintlify 文档
├── scripts/                # 构建/发布/测试脚本
└── test/                   # E2E + Docker 测试
```

---

## 4. 核心消息处理流程

### 4.1 消息接收到响应的完整流程

```
                          用户发送消息
                              │
                              ▼
┌─────────────────────────────────────────────────┐
│  ① Channel Monitor (平台特定)                    │
│  例: grammY polling / Baileys WebSocket          │
│  → 接收原始平台事件                               │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  ② Message Normalization (消息标准化)             │
│  BotMessageContext {                              │
│    from, to, text, threadId, messageId,          │
│    chatType, media[], channel, accountId         │
│  }                                               │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  ③ Security Gate (安全检查)                      │
│  - DM Policy: pairing / open / closed            │
│  - AllowFrom 白名单匹配                          │
│  - 命令权限 (command gating)                      │
│  - 群组提及门控 (mention gating)                   │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  ④ Chat Commands (内置命令)                       │
│  /status /new /reset /compact /think /verbose    │
│  → 命令直接处理, 不进入 Agent                      │
└────────────────────┬────────────────────────────┘
                     │ (非命令消息)
                     ▼
┌─────────────────────────────────────────────────┐
│  ⑤ Route Resolution (路由解析)                    │
│  resolveAgentRoute({cfg, channel, peer, ...})    │
│  匹配优先级:                                      │
│    binding.peer > binding.peer.parent >           │
│    binding.guild > binding.team >                 │
│    binding.account > binding.channel > default    │
│  → 输出: { agentId, sessionKey }                  │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  ⑥ Session Resolve (会话加载)                     │
│  - 查找/创建 SessionEntry                         │
│  - 加载会话历史 (transcript)                       │
│  - 应用会话覆盖 (model/thinking/verbose)          │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  ⑦ Queue / Lane 并发控制                          │
│  - 同一 Session 的请求排队                         │
│  - Lane 并发限制 (防止过载)                        │
│  - 去重 (相同消息不重复处理)                        │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  ⑧ Agent Runner (AI Agent 执行)                  │
│  runEmbeddedPiAgent({                             │
│    sessionKey, prompt, tools, model,              │
│    systemPrompt, history, thinkingLevel           │
│  })                                               │
│  - Auth Profile 选择 + 轮换                       │
│  - Context Window 检查                            │
│  - Failover 错误恢复                              │
│  - Compaction (上下文压缩)                         │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  ⑨ Stream Subscribe (流式订阅)                    │
│  subscribeEmbeddedPiSession()                    │
│  - 文本块流式输出 (soft chunk, paragraph split)   │
│  - Tool 执行 + 结果回传                           │
│  - Reasoning 标签处理                             │
│  - Block Reply 缓冲 + 刷新                        │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│  ⑩ Outbound Delivery (消息投递)                   │
│  - 文本分块 (按平台限制: Telegram 4000, WA 4000)  │
│  - Markdown 渲染 (按平台能力)                      │
│  - 媒体附件处理                                    │
│  - 打字指示器 (typing indicator)                   │
│  - 确认回执 (ack reactions)                        │
└─────────────────────────────────────────────────┘
```

### 4.2 Gateway WebSocket 通信流程

```
┌────────────┐         WebSocket          ┌──────────────┐
│            │ ◄──── JSON-RPC 请求 ──────  │              │
│  Gateway   │ ────── 响应/事件 ────────► │   Client     │
│  Server    │                             │  (CLI/App/   │
│            │ ◄─── subscribe ───────────  │   WebChat)   │
│            │ ────── stream events ─────► │              │
└────────────┘                             └──────────────┘

核心 RPC 方法:
├── agent / agent.wait          # 执行 Agent (同步/异步)
├── chat.send / chat.history    # 聊天消息管理
├── sessions.*                  # 会话 CRUD + 跨会话通信
├── channels.*                  # Channel 生命周期
├── config.get / config.patch   # 配置读写
├── models.list                 # 模型目录
├── skills.status               # Skills 状态
├── health                      # 健康检查
├── nodes.*                     # 设备节点管理
├── cron.*                      # 定时任务
├── browser.*                   # 浏览器控制
└── send                        # 出站消息
```

---

## 5. 核心子系统设计

### 5.1 Channel 插件体系

Channel 使用**适配器模式 (Adapter Pattern)**，每个平台实现标准的 `ChannelPlugin` 接口：

```typescript
type ChannelPlugin = {
  id: ChannelId;                    // "telegram" | "discord" | ...
  meta: ChannelMeta;                // 标签、文档路径、图标
  capabilities: ChannelCapabilities; // 支持的功能矩阵

  // 适配器 (按需实现)
  config: ChannelConfigAdapter;      // 配置解析
  setup?: ChannelSetupAdapter;       // 首次配置
  pairing?: ChannelPairingAdapter;   // DM 配对
  security?: ChannelSecurityAdapter; // 安全策略
  groups?: ChannelGroupAdapter;      // 群组规则
  mentions?: ChannelMentionAdapter;  // @提及处理
  outbound?: ChannelOutboundAdapter; // 出站消息
  gateway?: ChannelGatewayAdapter;   // Gateway 生命周期
  auth?: ChannelAuthAdapter;         // 认证
  streaming?: ChannelStreamingAdapter; // 流式推送
  threading?: ChannelThreadingAdapter; // 线程/回复
  messaging?: ChannelMessagingAdapter; // 消息监听
  actions?: ChannelMessageActionAdapter; // 消息动作
  onboarding?: ChannelOnboardingAdapter; // 引导配置
};
```

**两层架构**:
- **Core Channels** (内置): `src/telegram/`, `src/discord/`, `src/slack/`, `src/whatsapp/`, `src/signal/`, `src/imessage/`
- **Extension Channels** (扩展): `extensions/msteams/`, `extensions/matrix/`, `extensions/zalo/`, ...

### 5.2 Agent 系统

```
┌────────────────────────────────────────────────┐
│                Agent 配置层                      │
│  agents.list[]:                                 │
│    { id, model, fallbacks, workspace,           │
│      tools, sandbox, skills, subagents }        │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
┌────────────────────────────────────────────────┐
│           Pi Embedded Runner                    │
│  runEmbeddedPiAgent()                          │
│                                                 │
│  1. resolveModel() - 选择模型 + Provider        │
│  2. resolveAuthProfileOrder() - Auth 轮换       │
│  3. buildSystemPrompt() - 构建系统提示词         │
│  4. splitSdkTools() - 加载工具集                │
│  5. runEmbeddedAttempt() - 执行 Agent 循环      │
│     ├── LLM API 调用                            │
│     ├── Tool 执行 (bash/browser/canvas/...)     │
│     ├── 流式文本输出                             │
│     └── Failover 重试 (换 Auth/Model)           │
│  6. Session transcript 持久化                    │
└────────────────────────────────────────────────┘
```

**核心设计点**:

- **模型选择**: 支持 `provider/model` 格式，支持别名映射 (如 `opus-4.6` → `claude-opus-4-6`)
- **Auth Profile 轮换**: 多个凭证配置，自动切换避免限速
- **Failover 链**: `primary → fallback1 → fallback2`，自动降级
- **Context Window 守卫**: 检测上下文溢出，触发 Compaction
- **Session Compaction**: 长对话自动压缩，保留关键信息
- **Thinking Level**: 支持 off/minimal/low/medium/high/xhigh 推理级别

### 5.3 路由系统

路由系统决定每条消息交给哪个 Agent 处理，以及使用哪个 Session：

```
输入: { channel, accountId, peer, guildId, teamId }
                    │
                    ▼
            ┌─ binding.peer ─────── 精确用户匹配
            ├─ binding.peer.parent  线程父级继承
            ├─ binding.guild ────── Discord 服务器
     优先级  ├─ binding.team ─────── Slack/Teams 团队
            ├─ binding.account ──── 账号级别
            ├─ binding.channel ──── Channel 级别
            └─ default ──────────── 默认 Agent

输出: { agentId, sessionKey, mainSessionKey }
```

**Session Key 格式**: `agent:{agentId}:channel:{channel}:peer:{peerId}`

**DM Scope 策略**:
- `main`: 所有 DM 合并到主会话
- `per-peer`: 每个联系人独立会话
- `per-channel-peer`: 每个 Channel 每个联系人独立
- `per-account-channel-peer`: 完全隔离

### 5.4 插件系统

```
┌──────────────────────────────────────────────┐
│              Plugin Loader                    │
│  1. 扫描 extensions/ 目录                     │
│  2. 读取 manifest.json                        │
│  3. 通过 jiti 动态加载 TypeScript              │
│  4. 调用 register(api) 注册                   │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│           Plugin Registry                     │
│  {                                            │
│    plugins: [],    // 所有加载的插件            │
│    tools: [],      // 注册的工具               │
│    hooks: [],      // 注册的钩子               │
│    channels: [],   // 注册的 Channel           │
│    providers: [],  // 注册的 LLM Provider      │
│    services: [],   // 注册的服务               │
│    httpRoutes: [], // 注册的 HTTP 路由          │
│    commands: [],   // 注册的 CLI 命令           │
│    diagnostics: [] // 诊断适配器               │
│  }                                            │
└──────────────────────────────────────────────┘
```

**插件 API 接口**:
```typescript
type OpenClawPluginApi = {
  id: string;
  source: string;
  logger: PluginLogger;
  registerTool(factory, options);      // 注册工具
  registerHook(events, handler);       // 注册钩子
  registerProvider(provider);          // 注册 LLM 提供者
  registerChannel(channel);            // 注册消息频道
  registerGatewayMethod(method);       // 注册 Gateway RPC 方法
  registerService(id, service);        // 注册后台服务
  registerHttpRoute(route);            // 注册 HTTP 路由
  registerCliCommand(registrar);       // 注册 CLI 命令
};
```

### 5.5 会话与存储

```
~/.openclaw/
├── config.json5            # 主配置文件
├── credentials/            # Channel 凭证 (WhatsApp 等)
├── agents/
│   └── {agentId}/
│       ├── sessions/       # 会话 transcript (.jsonl)
│       └── workspace/      # Agent 工作区
├── workspace/              # 默认工作区
│   ├── AGENTS.md           # Agent 系统提示
│   ├── SOUL.md             # 人格提示
│   ├── TOOLS.md            # 工具提示
│   └── skills/             # 工作区 Skills
└── sessions/               # Pi session 日志
```

**SessionEntry 数据结构**:
```typescript
type SessionEntry = {
  sessionId: string;           // 唯一 ID
  sessionKey: string;          // 路由 Key
  updatedAt: number;           // 最后更新时间
  sessionFile?: string;        // Transcript 文件路径

  // 会话级别覆盖
  modelOverride?: string;      // 模型覆盖
  thinkingLevel?: ThinkLevel;  // 推理级别
  verboseLevel?: string;       // 详细程度
  groupActivation?: string;    // 群组激活方式
  queueMode?: string;          // 队列模式

  // 用量统计
  inputTokens?: number;
  outputTokens?: number;
  compactionCount?: number;

  // 上下文
  channel?: string;
  origin?: SessionOrigin;
};
```

---

## 6. 关键设计模式与技术决策

### 6.1 架构模式

| 模式 | 应用 | 说明 |
|------|------|------|
| **Adapter** | Channel 系统 | 每个平台实现统一接口，隔离平台差异 |
| **Plugin** | 扩展系统 | 通过注册表动态加载能力 |
| **Event-Driven** | Hook 系统 | 生命周期事件驱动扩展逻辑 |
| **Session-Scoped** | 状态管理 | 所有状态按 Session Key 隔离 |
| **Streaming-First** | 响应输出 | Block Reply 流式分块推送 |
| **Failover Chain** | AI 调用 | 多 Auth Profile + 多模型降级 |
| **Queue/Lane** | 并发控制 | 同 Session 串行，跨 Session 并行 |

### 6.2 核心技术决策

1. **WebSocket 控制面** — Gateway 使用 WS 而非 REST，支持双向通信和事件推送。所有客户端（CLI、macOS App、WebChat、iOS/Android Node）通过同一协议通信。

2. **Pi Agent Runtime 嵌入** — 不通过外部 API 调用 Agent，而是嵌入 Pi agent-core 直接运行，减少延迟并支持细粒度的工具集成。

3. **Channel 即插件** — 内置和扩展 Channel 使用相同的插件接口，降低添加新平台的成本。扩展作为独立 workspace 包，依赖隔离。

4. **Session Key 路由** — 基于 `agentId:channel:accountId:peer` 的组合 Key 精确路由，支持灵活的 DM 合并/隔离策略。

5. **Config as Code** — JSON5 配置支持注释，Zod schema 校验，运行时热重载。每个插件可声明自己的 config schema。

6. **Sandbox 隔离** — 非主会话（群组/Channel）可运行在 Docker sandbox 中，限制工具访问，保障安全。

### 6.3 安全模型

```
┌──────────────────────────────────────────┐
│              DM Policy                    │
│  "pairing" → 配对码验证 (默认)            │
│  "open"    → 需显式 allowFrom: ["*"]     │
│  "closed"  → 拒绝所有未知发送者            │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│          Sandbox (非主会话)               │
│  mode: "non-main"                        │
│  allowlist: bash, read, write, edit, ... │
│  denylist: browser, canvas, nodes, cron  │
│  → Docker 容器隔离                        │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│         Exec Approval (工具审批)          │
│  敏感工具执行前需 operator 确认            │
│  通过 Gateway WS 转发审批请求             │
└──────────────────────────────────────────┘
```

---

## 7. 扩展能力矩阵

### 7.1 工具系统

| 工具 | 说明 | 来源 |
|------|------|------|
| bash / exec | 命令行执行 (PTY 支持) | 内置 |
| browser | Playwright 浏览器控制 | 内置 |
| canvas | A2UI 可视化工作区 | 内置 |
| read / write / edit | 文件操作 | 内置 |
| memory_search | 记忆搜索 | 插件 |
| sessions_list/send/spawn | 跨会话通信 | 内置 |
| cron | 定时任务 | 内置 |
| camera / screen | 设备摄像头/录屏 | Node |
| system.run / system.notify | macOS 系统操作 | Node |
| location.get | 设备定位 | Node |

### 7.2 支持的 LLM 提供者

| 提供者 | 接入方式 |
|--------|----------|
| Anthropic (Claude) | OAuth / API Key |
| OpenAI (GPT/Codex) | OAuth / API Key |
| Google (Gemini) | API Key |
| AWS Bedrock | SDK |
| Ollama | 本地 |
| GitHub Copilot | Token Exchange |
| 自定义 Provider | 插件注册 |

---

## 8. 数据流总览图

```
     ┌─────────┐     ┌─────────┐     ┌─────────┐
     │ WhatsApp│     │Telegram │     │ Discord │    ...更多 Channels
     └────┬────┘     └────┬────┘     └────┬────┘
          │               │               │
          ▼               ▼               ▼
    ┌─────────────────────────────────────────────┐
    │         Channel Monitors (入站)              │
    │   Baileys WS  │  grammY Poll │  Carbon WS   │
    └────────────────────┬────────────────────────┘
                         │ normalized msg
                         ▼
    ┌─────────────────────────────────────────────┐
    │     Security → Routing → Session Resolve    │
    └────────────────────┬────────────────────────┘
                         │ { agentId, sessionKey }
                         ▼
    ┌─────────────────────────────────────────────┐
    │          auto-reply / Agent Runner           │
    │   ┌──────────────────────────────────┐      │
    │   │      Pi Embedded Runtime          │      │
    │   │  ┌─────────┐  ┌──────────────┐  │      │
    │   │  │  LLM    │  │ Tool Calls   │  │      │
    │   │  │  API    ├──►  bash/browser │  │      │
    │   │  │  Call   │  │  canvas/read  │  │      │
    │   │  └────┬────┘  └──────────────┘  │      │
    │   │       │ stream text              │      │
    │   └───────┼──────────────────────────┘      │
    └───────────┼─────────────────────────────────┘
                │ block replies
                ▼
    ┌─────────────────────────────────────────────┐
    │        Outbound Delivery Pipeline            │
    │   text chunking → markdown render →          │
    │   media attach → typing indicator →          │
    │   platform API send                          │
    └─────────────────────────────────────────────┘
                │
                ▼
          用户收到回复
```

---

## 9. 开发与运维

### 9.1 常用命令

```bash
# 安装依赖
pnpm install

# 开发模式 (自动重载)
pnpm gateway:watch

# 构建
pnpm build

# 类型检查 + Lint + 格式化
pnpm check

# 测试
pnpm test

# 运行 CLI
pnpm openclaw <command>

# 引导配置
pnpm openclaw onboard --install-daemon
```

### 9.2 发布通道

| 通道 | 说明 | npm tag |
|------|------|---------|
| stable | 正式发布 `vYYYY.M.D` | `latest` |
| beta | 预发布 `vYYYY.M.D-beta.N` | `beta` |
| dev | main 分支 HEAD | `dev` |

---

## 10. 总结

OpenClaw 的架构核心思想是 **"Gateway 即控制面，Agent 即产品"**：

1. **Gateway** 作为单一控制面，管理所有 Channel 连接、Agent 调度、Session 状态
2. **Channel 适配器** 抽象平台差异，统一消息处理流程
3. **Plugin 系统** 提供开放的扩展机制，新 Channel/Tool/Provider 均可插件化接入
4. **Session-Scoped 状态** 确保多设备、多用户场景下的正确隔离
5. **Streaming-First** 设计让 AI 响应实时推送到各平台
6. **Failover + Compaction** 机制保证长时间运行的稳定性

这种架构使得 OpenClaw 能够从单用户本地部署扩展到多设备远程场景，同时保持清晰的关注点分离和插件化可扩展性。
