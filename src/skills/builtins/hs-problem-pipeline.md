---
name: hs-problem-pipeline
description: "Problem 开发流水线：从 Notion Problem 出发，经过技术设计 → 代码实现 → PR → Code Review → 测试上线。当用户说 '帮我处理 Problem XXX' 或提供 Notion Problem 链接/ID 时使用。"
tags: [pipeline, workflow, problem, notion]
allowed-tools: bash_exec, claude_code, file_read, web_fetch, notion-rag__search, code-rag__search_code, code-rag__get_function, code-rag__get_file_structure
requires-env: [NOTION_API_KEY, GH_TOKEN]
requires-bins: [git, gh, claude]
---

# Problem Development Pipeline

从 Notion Problem 文档出发的完整开发流水线，每个关键节点都有人工确认。

```
Notion Problem → [✅] → Tech Design → [✅] → Implement + PR → [✅] → Code Review → [✅] → Release
```

## Inputs

| Input | Description |
|-------|-------------|
| `problem` | Notion Problem 的页面 ID、URL 或标题关键词 |
| `repo` | 目标 GitHub 仓库（owner/name） |
| `base_branch` | 目标分支（默认 `main`） |
| `deploy_env` | 发布环境（默认 `production`） |

如果用户只提供了 Problem 链接，从 Notion 内容中推断 `repo`；推断不出则询问。

## Pipeline Stages

---

### Stage 1: 理解 Problem

**目标**：从 Notion 拉取 Problem 文档，理解需求全貌。

#### 1a. 获取 Problem 文档

根据用户提供的输入定位 Problem：

- **Notion URL/ID**：直接用 `bash_exec` 调 Notion API 获取页面属性和 Markdown 正文

```bash
NOTION_KEY="$NOTION_API_KEY"
# 获取页面属性（标题、状态、优先级、关联等）
curl -s "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03"

# 获取页面正文（Markdown 格式，一次性拿到完整内容）
curl -s "https://api.notion.com/v1/pages/{page_id}/markdown" \
  -H "Authorization: Bearer $NOTION_KEY" \
  -H "Notion-Version: 2025-09-03"
```

- **标题关键词**：先用 `notion-rag__search` 搜索，找到对应页面后再获取详情

#### 1b. 提取关键信息

从 Problem 文档中提取：
- **问题描述**：用户/业务遇到了什么问题
- **期望行为**：预期应该怎样工作
- **优先级/状态**：当前 Problem 的状态和优先级
- **关联实体**：相关的 Solution、Bug、设计文档（如有 Relation 属性则追溯获取）
- **约束条件**：性能、兼容性、截止日期等

#### 1c. 补充上下文

用 `notion-rag__search` 搜索相关内容（MCP 工具如可用）：
- 搜索关键词：Problem 标题、涉及的模块名、功能名
- 查找已有的设计文档、技术决策、相关 Bug

**[CHECKPOINT 1]** — 向用户展示 Problem 理解：

```
📋 Problem 理解

标题: <title>
状态: <status>
优先级: <priority>

问题描述:
<summary of the problem in 2-3 sentences>

期望行为:
<expected behavior>

关联文档:
- <related docs if any>

约束:
- <constraints if any>

我的理解正确吗？有需要补充的吗？
```

等待用户确认。如果理解有偏差，根据反馈调整后再次确认。

---

### Stage 2: 技术设计

**目标**：分析代码现状，产出技术设计方案。

#### 2a. 代码现状分析

使用代码分析工具了解当前实现（MCP 工具如可用，否则用 `bash_exec` + `file_read`）：

- **项目结构**：`code-rag__get_file_structure` 获取仓库文件结构
- **相关代码**：`code-rag__search_code` 搜索与 Problem 相关的模块/函数
- **具体实现**：`code-rag__get_function` 获取关键函数的完整代码
- **本地文件**：`file_read` 读取核心文件

重点分析：
- 哪些模块/文件需要修改
- 现有代码的模式和风格
- 可能的影响范围

#### 2b. 产出技术设计

基于 Problem 理解 + 代码分析，产出技术设计方案：

```
## 技术设计方案

### 1. 方案概述
<1-2 句话描述整体方案>

### 2. 修改范围

| 文件/模块 | 改动类型 | 说明 |
|-----------|---------|------|
| `path/to/file` | 新增/修改/删除 | <具体改什么> |

### 3. 实现步骤
1. <步骤 1 — 做什么、为什么>
2. <步骤 2>
3. ...

### 4. 接口变更（如有）
- API 新增/变更：<描述>
- 数据结构变更：<描述>

### 5. 风险和注意事项
- <风险 1>：<应对措施>
- <风险 2>：<应对措施>

### 6. 测试策略
- 单测：<需要测试什么>
- 集成测试：<需要验证什么>
- 手动验证：<需要检查什么>
```

如果方案有多个选择，列出对比（类似 hs-tech-answer 的对比表），并给出推荐。

**[CHECKPOINT 2]** — 向用户展示技术设计：

```
技术设计完成。

<完整设计方案>

是否按此方案实现？还是需要调整？
```

等待用户确认。用户可能会：
- 直接确认 → 进入 Stage 3
- 要求调整方案 → 修改后重新展示
- 选择某个备选方案 → 按选择的方案继续

---

### Stage 3: 实现 + 提 PR

**目标**：基于技术设计方案，实现代码并提交 PR。

加载并执行 `hs-submit-pr` skill：

```
file_read the `hs-submit-pr` skill from <available_skills>
```

将 Stage 2 的设计方案作为 task 输入：
- `task` = 技术设计方案的实现步骤（完整传入，不要摘要）
- `repo` = 目标仓库
- `base_branch` = 目标分支
- 分支名格式：`feat/<short-desc>`（Problem 是新功能/改进，用 feat 而非 fix）
- 跳过 Step 1（已有确认），从 Step 2 clone 开始

目标输出：
- PR URL
- 改动文件列表
- 测试结果

**[CHECKPOINT 3]** — 向用户展示 PR 信息：

```
PR 已创建: <PR URL>

分支: feat/<short-desc> → <base_branch>
改动摘要:
<diff summary — 文件列表 + 核心改动说明>

测试结果: <pass / fail / 无测试>
CI 状态: <passing / pending / failing>

是否继续进行 Code Review？
```

如果 CI 失败 → 分析失败原因，尝试修复后重新推送。如果无法自动修复 → 停止，告知用户。
等待用户确认后继续。

---

### Stage 4: Code Review

**目标**：对 PR 进行结构化代码审查。

加载并执行 `hs-review-pr` skill：

```
file_read the `hs-review-pr` skill from <available_skills>
```

输入：Stage 3 产出的 PR URL/编号。

执行 hs-review-pr 的完整流程（fetch → analyze → quality → security → review）。

Review 完成后，根据结果判断：

- **Approve** → 展示 review 摘要，继续 Stage 5
- **Request Changes** → 展示问题列表，回到 Stage 3 修复后重新 review

**[CHECKPOINT 4]** — 向用户展示 Review 结果：

```
Code Review 完成。

<review summary — strengths, issues, recommendation>

结论: <Approve / 需要修改>

<如果 Approve>: 是否继续发布到 <deploy_env>？
<如果需要修改>: 以上问题需要先修复，是否开始修复？
```

等待用户确认。

---

### Stage 5: 测试上线

**目标**：合并 PR，打 tag，部署。

前置条件检查：
- PR Review 已通过（Stage 4 Approve）
- PR 已合并（如还未合并，提示用户先 merge 或用 `gh pr merge` 合并）
- CI 全部通过

```bash
# 合并 PR（如用户确认）
gh pr merge <PR_NUMBER> --repo <repo> --squash --delete-branch
```

加载并执行 `hs-release` skill：

```
file_read the `hs-release` skill from <available_skills>
```

将 Problem 标题和设计方案摘要作为 changelog 内容的一部分传入。

**[CHECKPOINT 5]** — 发布完成后报告：

```
发布完成 ✓

版本: <version>
部署环境: <deploy_env>
Release: <url>
PR: <pr_url>

Problem "<title>" 已完成从设计到上线的全流程。
```

---

## Abbreviated Mode

用户可以只执行部分阶段：

| 用户指令 | 执行阶段 |
|---------|---------|
| "分析 Problem XXX" | Stage 1 only |
| "帮我设计 Problem XXX 的方案" | Stage 1 + 2 |
| "实现 Problem XXX 并提 PR" | Stage 1 + 2 + 3 |
| "Review PR #123" | Stage 4 only |
| "发布 v1.2.3" | Stage 5 only |
| "从头到尾处理 Problem XXX" | Stage 1 + 2 + 3 + 4 + 5 |

## Principles

1. **不跳过 checkpoint** — 每个确认点都必须等用户明确同意才继续
2. **失败即停** — 任何阶段出错，报告后等待指示，不自动重试
3. **状态透明** — 每个阶段开始时告知用户当前处于哪一步（如 "▶ Stage 3/5: 实现 + 提 PR"）
4. **可恢复** — 用户可以在任意 checkpoint 后终止，状态不丢失（设计方案在对话中，PR 还在 GitHub 上）
5. **设计先行** — 不跳过技术设计阶段，即使 Problem 看起来简单；简单任务的设计方案可以简短，但不能没有
6. **读取自动，写入确认** — 从 Notion/代码读取信息不需要确认；创建分支、提 PR、合并、发布都需要用户确认
