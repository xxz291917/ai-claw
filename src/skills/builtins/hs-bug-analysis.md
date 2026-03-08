---
name: hs-bug-analysis
description: "Structured workflow to analyze a bug or issue: gather context, locate root cause, and produce an actionable fix plan. Use when asked to investigate a bug, diagnose an error, or understand why something broke."
tags: [debugging, analysis, quality]
allowed-tools: bash_exec, file_read, notion-rag__search, code-rag__search_code, code-rag__get_function, code-rag__get_file_structure
requires-bins: [gh]
---

# Bug Analysis Workflow

Structured investigation: gather symptoms → search context → locate root cause → propose fix plan.

## Inputs

Collect these before starting (ask if missing):

| Input | Description | Example |
|-------|-------------|---------|
| `symptom` | Error message, unexpected behavior, or issue description | "用户登录后页面空白" |
| `repo` | Affected GitHub repo (optional) | `housesigma/backend` |
| `issue_number` | GitHub issue number (optional) | `#456` |
| `env` | Where it occurs: prod / staging / local | `prod` |

## Steps

### 1. Understand the symptom

If an issue number is provided:
```bash
gh issue view <issue_number> --repo <repo>
```

Summarize:
- **现象**：用户看到了什么
- **影响范围**：哪些用户/场景受影响
- **首次出现时间**：什么时候开始的（如已知）
- **复现步骤**：如何触发

### 2. Gather context from knowledge sources

**需求和历史** — 用 `notion-rag__search`：
- 搜索该功能的需求文档、设计决策、已知限制
- 关键词：功能名、模块名、错误关键词
- 查找是否有相关的历史 bug 记录或已知问题

**代码定位** — 用 `code-rag__search_code` 和 `code-rag__get_function`：
- 搜索错误关键词、函数名、相关模块
- 找到最可能出问题的代码路径
- 查看调用链：谁调用了出错的函数？

**项目结构** — 用 `code-rag__get_file_structure`（首次分析时）：
- 了解整体架构，定位相关模块所在目录

> 如果知识库无相关结果，直接根据症状和代码分析继续。

### 3. Deep dive into suspect code

读取最可疑的文件和函数：
```bash
# 查看相关文件
file_read <suspect_file>

# 查看 git 历史（如有 clone）
git -C <repo_path> log --oneline -20 -- <suspect_file>
git -C <repo_path> show <commit_hash>
```

关注：
- 最近有没有改动该文件？
- 是否有边界条件未处理（null、空数组、并发）？
- 是否有依赖的外部服务或配置变更？

### 4. Check logs and related issues (if applicable)

```bash
# 如果有 Sentry 工具可用
sentry_query issue <issue_id>

# GitHub 上是否有类似 issue
gh issue list --repo <repo> --search "<keyword>" --state all
```

### 5. Root cause analysis

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

### 6. Propose fix plan

给出 1-3 个修复方案，每个包含：

```
方案 A: <title>
- 改动：<描述要改什么>
- 风险：<是否有副作用>
- 预计工作量：小 / 中 / 大
- 推荐度：⭐⭐⭐
```

**推荐方案**：选出最佳方案，说明理由。

### 7. Handoff

输出完整分析报告，格式：

```
## Bug 分析报告

**症状**: <symptom>
**根因**: <root cause>
**影响**: <scope>
**严重程度**: <level>

**推荐修复方案**: <方案 A 描述>

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
