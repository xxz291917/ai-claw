---
name: hs-pipeline
description: "End-to-end engineering pipeline: bug analysis → solution → code change → PR → release. Use when asked to handle a complete issue lifecycle from investigation to deployment, or when the user says 'help me fix and release issue #X'."
tags: [pipeline, workflow, automation]
allowed-tools: bash_exec, file_read, notion-rag__search, code-rag__search_code, code-rag__get_function, code-rag__get_file_structure
requires-bins: [git, gh, claude]
---

# Engineering Pipeline

Full lifecycle workflow with human checkpoints at every critical decision point.

```
Bug Analysis → [✅ 确认方案] → Submit PR → [✅ 确认上线] → Release
```

## Inputs

| Input | Description |
|-------|-------------|
| `issue` | Issue 描述、编号或错误信息 |
| `repo` | 目标 GitHub 仓库 |
| `deploy_env` | 发布环境（默认 production） |

## Pipeline Stages

---

### Stage 1: Bug Analysis

加载并执行 `hs-bug-analysis` skill：

```
file_read the `hs-bug-analysis` skill from <available_skills>
```

目标输出：
- 根因分析
- 推荐修复方案
- 相关文件列表

**[CHECKPOINT 1]** — 向用户展示分析结果：

```
分析完成。

根因: <root_cause>
推荐方案: <fix_plan>
影响文件: <files>

是否按此方案继续？还是需要调整？
```

等待用户确认后继续。如果用户要求调整方案，重新分析后再次确认。

---

### Stage 2: Implement & Submit PR

加载并执行 `hs-submit-pr` skill：

```
file_read the `hs-submit-pr` skill from <available_skills>
```

将 Stage 1 的输出作为 task 输入：
- `task` = 修复方案描述
- `repo` = 目标仓库
- 跳过 Step 1（已有确认），从 Step 2 clone 开始

目标输出：
- PR URL
- 改动文件列表
- 测试结果

**[CHECKPOINT 2]** — 向用户展示 PR 信息：

```
PR 已创建: <PR URL>

改动摘要:
<diff summary>

CI 状态: <passing / pending / failing>

是否继续发布到 <deploy_env>？
```

如果 CI 失败 → 停止，告知用户需要先修复 CI。
等待用户确认后继续。

---

### Stage 3: Release

加载并执行 `hs-release` skill：

```
file_read the `hs-release` skill from <available_skills>
```

前置条件检查：
- PR 已合并（如果还未合并，提示用户先 merge）
- CI 全部通过

将 Stage 1 的根因描述作为 changelog 内容的一部分传入。

**[CHECKPOINT 3]** — 发布完成后报告：

```
发布完成 ✓

版本: <version>
部署环境: <deploy_env>
Release: <url>
```

---

## Abbreviated Mode

如果用户只想执行部分阶段，可以跳过：

| 用户指令 | 执行阶段 |
|---------|---------|
| "分析 bug #123" | Stage 1 only |
| "修复 bug #123 并提 PR" | Stage 1 + Stage 2 |
| "发布 v1.2.3" | Stage 3 only |
| "从头到尾处理 bug #123" | Stage 1 + 2 + 3 |

## Principles

1. **不跳过 checkpoint** — 每个确认点都必须等用户明确同意才继续
2. **失败即停** — 任何阶段出错，报告后等待指示，不自动重试
3. **状态透明** — 每个阶段开始时告知用户当前处于哪一步
4. **可恢复** — 用户可以在任意 checkpoint 后终止，状态不丢失（PR 还在，分析结果在对话中）
