# 未来扩展功能规划

本文档记录从 OpenClaw 等项目中调研到的有价值的设计思路，作为 ai-claw 未来改造的参考。

---

## 1. 运行时配置修改（gateway tool + RPC）

**现状：** ai-claw 配置走环境变量 + `setEnv()`，运行时不可改。

**OpenClaw 方案：**
- AI agent 不直接写配置文件，而是通过专用 `gateway` tool 向宿主进程发 RPC 请求
- 配置文件：`~/.openclaw/openclaw.json`（JSON5 格式）
- 支持的操作：
  - `config.get` — 读取当前配置（返回快照 + hash）
  - `config.patch` — 局部更新（JSON Merge Patch）
  - `config.apply` — 全量替换
  - `restart` — SIGUSR1 热重启
- 安全机制：ownerOnly 权限、乐观锁（baseHash 防并发）、环境变量引用保留、审计日志、5 层备份轮转
- 修改后通过 SIGUSR1 信号触发热重启生效

**改造要点：**
- 新增 `gateway` tool，走进程内 RPC 而非文件操作
- 配置 schema 校验 + 原子写入
- 热重启机制（SIGUSR1 或 process manager）

---

## 2. 可插拔记忆后端

**现状：** ai-claw 记忆系统为单一 SQLite FTS5 后端，无向量搜索。

**OpenClaw 方案：**

### 2.1 架构设计

统一接口 `MemorySearchManager`：

```typescript
interface MemorySearchManager {
  search(query, opts?)                // 搜索记忆
  readFile(params)                    // 读取记忆文件片段
  status()                            // 后端状态
  sync?(params?)                      // 同步（外部后端用）
  probeEmbeddingAvailability()        // 探测 embedding 可用性
  close?()
}
```

### 2.2 三种后端

| 后端 | 类型 | 说明 |
|------|------|------|
| **builtin** | 内置 SQLite | FTS5 + sqlite-vec 向量搜索，默认后端 |
| **QMD** | 外部 sidecar | 独立进程（query-memory-daemon），BM25 + 向量 + reranking |
| **LanceDB** | 插件 | 向量数据库，多种 embedding provider |

### 2.3 插件 slot 机制

配置中 `plugins.slots.memory` 可选值：
- `"memory-core"` — 默认，内置 SQLite
- `"memory-lancedb"` — LanceDB 向量后端
- `"none"` — 禁用记忆

### 2.4 Fallback 降级

```
Agent → memory_search tool
  ↓
getMemorySearchManager()
  ├── backend="qmd" → QmdMemoryManager（外部 qmd 进程）
  │     ├── 支持 MCP 协议路由（mcporter）
  │     └── 失败自动 fallback 到 builtin
  └── backend="builtin" → MemoryIndexManager（本地 SQLite）
```

### 2.5 Embedding 支持

OpenClaw 支持多种 embedding provider：
- OpenAI（含 batch）
- Gemini（含 batch）
- Voyage（含 batch）
- Mistral
- Ollama（本地 / 自部署）
- Local（node-llama-cpp）
- 自动探测 + fallback 链

### 2.6 LanceDB 插件亮点

- 生命周期钩子实现 **auto-capture**（自动记忆）和 **auto-recall**（自动召回）
- 支持自定义 embedding API（OpenAI 兼容 baseURL + dimensions）
- 记忆条目带 **importance scoring** 和 **categorization**

### 2.7 改造路径

1. 抽象 `MemorySearchManager` 接口
2. 现有 FTS5 实现作为 builtin 后端
3. 新增向量搜索后端（LanceDB 或类似方案）
4. 配置驱动后端选择 + fallback 机制
5. 按需引入 embedding provider

---

## 3. Docker 沙箱隔离

**现状：** ai-claw 通过 `bash_exec` 命令白名单限制 AI 可执行的操作。

**OpenClaw 方案：**
- 可选 Docker 沙箱，按工具类型分流：
  - **沙箱内执行：** bash, file_read, file_write, edit, browser（用户代码执行）
  - **宿主进程执行：** cron, message, memory, config（平台操作）
- 容器挂载用户 workspace 目录，隔离系统其余部分
- 两种方案可共存（白名单 + 容器隔离）

**改造要点：**
- 工具执行层抽象：本地执行 vs 容器执行
- Docker API 集成（创建/销毁/通信）
- workspace 挂载策略

---

## 对比总结

| 维度 | ai-claw 现状 | OpenClaw 参考 | 优先级 |
|------|-------------|--------------|--------|
| 配置修改 | 环境变量，运行时不可改 | gateway tool + RPC + 热重启 | 中 |
| 记忆后端 | 单一 SQLite FTS5 | 插件化，builtin / QMD / LanceDB | 中 |
| 向量搜索 | 无 | sqlite-vec 或 LanceDB | 低 |
| embedding | 无 | 多 provider 支持 | 低 |
| 自动记忆 | compaction 提取 | 插件钩子 auto-capture/recall | 低 |
| 代码沙箱 | 命令白名单 | Docker 容器隔离 | 低 |
