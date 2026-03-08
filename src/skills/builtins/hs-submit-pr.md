---
name: hs-submit-pr
description: "Complete workflow to implement a code change in any GitHub repository and submit a pull request. Use when asked to fix a bug, add a feature, or make any code change in a GitHub repo and create a PR."
tags: [git, github, code-change, pull-request]
allowed-tools: bash_exec, claude_code, file_read, notion-rag__search, code-rag__search_code, code-rag__get_function, code-rag__get_file_structure
requires-bins: [git, gh, claude]
---

# Submit PR Workflow

End-to-end workflow: clone repo → implement change → commit → push → create PR.

## Inputs

Collect these before starting (ask if missing):

| Input | Description | Example |
|-------|-------------|---------|
| `repo` | GitHub repo (owner/name or full URL) | `housesigma/backend` |
| `task` | What to implement or fix | "Fix null pointer in UserService.getById()" |
| `base_branch` | Target branch for PR (default: `main`) | `main` / `develop` |
| `issue_number` | Related issue number (optional) | `#123` |

## Steps

### 1. Confirm inputs

Echo back what you understood:
```
仓库: <repo>
任务: <task>
目标分支: <base_branch>
关联 Issue: <issue_number 或 "无">
```

Ask: "确认后开始，还是需要调整？"

### 2. Clone the repository

```bash
# Clone into workspace (shallow clone for speed)
git clone --depth=1 --branch <base_branch> https://github.com/<repo>.git /tmp/pr-work/<repo-name>
```

If the repo requires auth:
```bash
gh repo clone <repo> /tmp/pr-work/<repo-name> -- --depth=1 --branch <base_branch>
```

Check result — if clone fails, report the error and stop.

### 3. Gather context

Before writing any code, use the available knowledge sources to understand the task fully.

**需求和背景** — 用 `notion-rag__search` 查询 Notion：
- 搜索与任务相关的需求文档、设计决策、已知问题
- 关键词：issue 标题、模块名、功能描述
- 如果找到相关文档，摘录关键约束和预期行为

**代码上下文** — 用 `code-rag__search_code` 和 `code-rag__get_function`：
- 搜索与任务相关的现有实现、类似函数、调用方式
- 查看项目结构：`code-rag__get_file_structure`
- 理解代码风格和模式，实现时保持一致

**本地文件** — 用 `file_read` 或 `bash_exec`：
- 读取 clone 后仓库的 README，了解构建和测试命令
- 读取直接相关的文件（不需要通读整个项目）

> 如果以上来源均无相关信息，直接根据任务描述和 clone 的代码继续。

### 4. Create a feature branch

```bash
# Generate a short, descriptive branch name
# Format: fix/<short-desc> or feat/<short-desc>
git -C /tmp/pr-work/<repo-name> checkout -b fix/<short-desc>
```

### 5. Implement the change

Use the `claude_code` tool with a precise task description:

```
Task: "<detailed task description>"

Working in: /tmp/pr-work/<repo-name>

Requirements:
- Implement ONLY what is described in the task
- Do not refactor unrelated code
- Add or update tests if the project has a test suite
- Follow the existing code style
- Do not change package.json / go.mod / requirements.txt unless necessary

After finishing:
- Run the project's test command if one exists (check package.json / Makefile / README)
- Report what was changed and why
```

Wait for `claude_code` to complete. Review its summary output.

### 6. Verify changes

```bash
# Review what was changed
git -C /tmp/pr-work/<repo-name> diff --stat HEAD

# Check no unintended files changed
git -C /tmp/pr-work/<repo-name> status
```

If something looks wrong, ask the user before proceeding.

### 7. Commit and push

```bash
# Stage all changes
git -C /tmp/pr-work/<repo-name> add -A

# Commit with conventional commit message
git -C /tmp/pr-work/<repo-name> commit -m "fix: <short description>

<optional longer explanation>

Closes #<issue_number>"

# Push branch
git -C /tmp/pr-work/<repo-name> push origin fix/<short-desc>
```

### 8. Create the pull request

```bash
gh pr create \
  --repo <repo> \
  --head fix/<short-desc> \
  --base <base_branch> \
  --title "fix: <short description>" \
  --body "## Summary

<1-3 sentence description of what was changed and why>

## Changes

- <bullet point list of key changes>

## Testing

<describe how to verify the fix, or "Existing tests pass" if applicable>

$([ -n "<issue_number>" ] && echo "Closes #<issue_number>")"
```

### 9. Report result

Output:
```
PR 已创建: <PR URL>

分支: fix/<short-desc> → <base_branch>
改动文件: <list>
```

## Error Handling

| Error | Action |
|-------|--------|
| Clone fails (auth) | Try `gh repo clone` with GH_TOKEN |
| Clone fails (not found) | Report repo name and stop |
| `claude_code` reports failure | Show error, ask user how to proceed |
| Push rejected (branch exists) | Append `-v2` suffix to branch name and retry |
| Tests fail | Report failures, ask user if they want to proceed anyway |

## Cleanup (optional)

After PR is merged or closed:
```bash
rm -rf /tmp/pr-work/<repo-name>
```

## Notes

- Always use `/tmp/pr-work/` as the clone directory to avoid polluting the workspace
- Never force-push to the base branch (`main`/`develop`)
- If the task is ambiguous, ask before cloning — cheap to clarify, expensive to redo
- For large repos, consider `--depth=1` + `--no-tags` to speed up cloning
