---
name: hs-release
description: "Release workflow: verify merged PRs, generate changelog, tag version, and trigger deployment. Use when asked to release, publish, or deploy a new version of a service."
tags: [release, deployment, git]
allowed-tools: bash_exec, file_read, notion-rag__search, code-rag__get_file_structure
requires-bins: [git, gh]
---

# Release Workflow

End-to-end release: verify → changelog → tag → deploy.

## Inputs

Collect these before starting (ask if missing):

| Input | Description | Example |
|-------|-------------|---------|
| `repo` | GitHub repo to release | `housesigma/backend` |
| `version` | New version number (semver) | `v1.4.2` |
| `base_branch` | Branch to release from (default: `main`) | `main` |
| `deploy_env` | Target environment | `production` / `staging` |

If `version` is not provided, suggest the next version based on recent commits:
- Breaking changes → major bump
- New features → minor bump
- Bug fixes only → patch bump

## Steps

### 1. Confirm release scope

```bash
# View commits since last tag
gh api repos/<repo>/releases/latest --jq '.tag_name'
git -C <repo_path> log <last_tag>..HEAD --oneline
```

查找相关 Notion 文档（release notes 草稿、计划上线的功能）：
- 用 `notion-rag__search` 搜索："release" / "上线" / 版本号

列出本次 release 包含的内容，让用户确认：
```
版本: <version>
分支: <base_branch>
包含变更:
- <commit list>

确认发布？
```

### 2. Pre-release checks

```bash
# CI 状态
gh run list --repo <repo> --branch <base_branch> --limit 5

# 是否有未合并的 hotfix PR
gh pr list --repo <repo> --base <base_branch> --state open
```

如果 CI 失败或有待合并的关键 PR → **停止**，告知用户。

### 3. Generate changelog

根据 commit messages 生成 changelog，格式：

```markdown
## <version> — <date>

### Features
- <feat commits>

### Bug Fixes
- <fix commits>

### Other Changes
- <chore/docs/refactor commits>
```

规则：
- 只包含 `feat:` / `fix:` / `perf:` / `break:` 类型的 commit
- 忽略 `chore:` / `docs:` / `style:` (除非用户要求包含)
- 合并 squash PR 时，使用 PR 标题而非 commit message

### 4. Update version files (if applicable)

根据项目类型检查是否需要更新版本号：

```bash
# Node.js
file_read package.json  # 检查 version 字段

# Go
file_read go.mod

# Python
file_read pyproject.toml / setup.py
```

如果有版本文件，更新它（用 `bash_exec` 或告知用户手动更新）。

### 5. Create release tag

```bash
# 创建 annotated tag
git -C <repo_path> tag -a <version> -m "Release <version>"

# 推送 tag
git -C <repo_path> push origin <version>
```

### 6. Create GitHub Release

```bash
gh release create <version> \
  --repo <repo> \
  --title "<version>" \
  --notes "<changelog content>" \
  --target <base_branch>
```

如果是预发布版本（rc / beta）：
```bash
gh release create <version> --repo <repo> --prerelease ...
```

### 7. Trigger deployment (if configured)

根据项目的部署方式执行：

**PM2（当前项目）**:
```bash
bash_exec: ssh <server> "cd <deploy_path> && git pull && npm run build && pm2 restart <app_name>"
```

**GitHub Actions workflow**:
```bash
gh workflow run deploy.yml --repo <repo> --field environment=<deploy_env> --field version=<version>
```

**手动部署**：告知用户需要手动执行的命令。

### 8. Post-release verification

```bash
# 确认 tag 已推送
gh release view <version> --repo <repo>

# 检查部署状态（如有 CI）
gh run list --repo <repo> --limit 3
```

### 9. Report result

```
Release 完成 ✓

版本: <version>
发布时间: <timestamp>
GitHub Release: <url>
部署环境: <deploy_env>

Changelog 摘要:
<brief summary>
```

## Error Handling

| Error | Action |
|-------|--------|
| CI 失败 | 停止发布，报告失败的 job |
| Tag 已存在 | 询问是否覆盖（默认不覆盖）|
| 部署失败 | 报告错误，提示回滚命令 |
| 无法确定版本号 | 列出最近5个 tag，请用户指定 |

## Rollback

如果上线后发现问题：

```bash
# 回滚到上一个版本
git -C <repo_path> revert <version_tag>
# 或者重新部署上一个版本
gh release view <prev_version> --repo <repo>
```

## Notes

- 发布前必须确认 CI 全部通过
- tag 一旦推送到远端不要删除，用新 patch 版本修复
- production 发布建议在低峰期执行
