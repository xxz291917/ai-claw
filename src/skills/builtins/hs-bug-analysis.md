---
name: hs-bug-analysis
description: "结构化 bug 分析：收集信息 → 定位代码 → 根因分析 → 修复方案。支持 Sentry issue 和人工描述。"
tags: [bug, error, sentry, debugging, analysis, 报错, 异常, 排查, 线上问题, crash, 500, 白屏]
allowed-tools: bash_exec, file_read, web_fetch, sentry_query, notion-rag__search, code-rag__search_code, code-rag__get_function, code-rag__get_file_structure
---

# Bug 分析工作流

结构化排查：收集信息 → 定位代码 → 根因分析 → 修复方案。

## 触发条件

以下任一情况都应触发此流程：
- 用户提到 Sentry issue 号（如 "分析 Sentry 118889"）
- 用户描述了一个 bug 或异常行为
- 用户提到报错信息、错误日志、线上问题
- 用户问 "为什么 XX 不工作" / "XX 怎么挂了"

## Inputs

从用户消息中提取（缺少则问）：

| Input | Description | Example |
|-------|-------------|---------|
| `sentry_issue` | Sentry issue ID（如有） | `118889` |
| `symptom` | 错误现象或用户描述 | "用户登录后页面空白" |
| `env` | 发生环境：prod / staging / local（默认 prod） | `prod` |

## Steps

### 1. 收集错误信息

**有 Sentry issue ID** → 先用 `sentry_query` 获取完整信息：
```
sentry_query issue <issue_id>
```

从 Sentry 中提取：
- 错误类型和消息
- 堆栈跟踪（stacktrace）
- 影响用户数和事件数
- 首次/最近出现时间
- 相关的 tags（浏览器、OS、URL 等）

**无 Sentry ID** → 根据用户描述整理：
- **现象**：用户看到了什么
- **影响范围**：哪些用户/场景受影响
- **首次出现时间**：什么时候开始的（如已知）
- **复现步骤**：如何触发

### 2. 搜索相关上下文

> 注意：`notion-rag__search`、`code-rag__*` 为 MCP 工具，仅在对应 MCP 服务连接时可用。如果不可用，跳过相关步骤，直接根据 Sentry 数据和本地文件分析。

**需求和历史** — 用 `notion-rag__search`（如可用）：
- 搜索该功能的需求文档、设计决策、已知限制
- 关键词：功能名、模块名、错误关键词
- 查找是否有相关的历史 bug 记录或已知问题

**代码定位** — 用 `code-rag__search_code` 和 `code-rag__get_function`（如可用）：
- 从 Sentry stacktrace 中提取文件名和函数名进行搜索
- 搜索错误关键词、相关模块
- 找到最可能出问题的代码路径
- 查看调用链：谁调用了出错的函数？

**项目结构** — 用 `code-rag__get_file_structure`（首次分析时）：
- 了解整体架构，定位相关模块所在目录

> 如果知识库无相关结果，直接根据 Sentry 数据和代码分析继续。

### 3. 深入可疑代码

读取最可疑的文件和函数：
```bash
# 查看相关文件
file_read <suspect_file>
```

关注：
- Sentry stacktrace 指向的具体代码行
- 是否有边界条件未处理（null、空数组、并发）？
- 是否有依赖的外部服务或配置变更？
- 最近是否有相关改动？

### 4. 根因分析

用 "5 Whys" 方法：

```
症状: <symptom>

Why 1: 为什么出现这个症状？
  → <answer>
Why 2: 为什么会 <answer>？
  → <answer>
...
根因: <root cause>
```

输出结论：
- **根因**：一句话描述
- **触发条件**：什么情况下触发
- **影响范围**：哪些模块/用户受影响
- **严重程度**：Critical / High / Medium / Low

### 5. 修复方案

给出 1-3 个修复方案，每个包含：

```
方案 A: <title>
- 改动：<描述要改什么>
- 风险：<是否有副作用>
- 预计工作量：小 / 中 / 大
- 推荐度：⭐⭐⭐
```

**推荐方案**：选出最佳方案，说明理由。

### 6. 输出报告

```
## Bug 分析报告

**Sentry**: #<issue_id>（如适用）
**症状**: <symptom>
**根因**: <root cause>
**影响**: <scope>
**严重程度**: <level>

**推荐修复方案**: <方案描述>

**相关文件**:
- <file1> — <why relevant>
- <file2> — <why relevant>

**下一步**: 是否需要我直接修复并提交 PR？
```

等待用户确认后，可以直接触发 `hs-submit-pr` 流程。

## Notes

- 分析阶段只读，不改任何代码
- 如果根因不确定，列出 2-3 个假设并标明置信度
- 严重程度 Critical/High → 在报告顶部加醒目提示
- **必须按步骤执行**，不要只查一次 Sentry 就直接回复，要完成完整的分析流程
