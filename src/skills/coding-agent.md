---
name: coding-agent
description: "Run external coding agents (Claude Code, Codex CLI) as sub-processes for delegated tasks. Use when orchestrating other AI agents."
tags: [agent, automation, delegation]
allowed-tools: Bash
---

# Coding Agent Orchestration

Use bash to spawn and manage external coding agents for delegated tasks.

## Available Agents

| Agent | Command | Best for |
|-------|---------|----------|
| Claude Code | `claude "prompt"` | Complex multi-file changes |
| Codex CLI | `codex exec "prompt"` | Quick one-shot tasks |

## Quick Start: One-Shot Tasks

```bash
# Claude Code
claude "Add error handling to the API calls in src/server.ts"

# Codex CLI (needs git repo)
codex exec "Fix the failing test in test/api.test.ts"
```

## Background Mode for Long Tasks

For longer tasks, run in background:

```bash
# Start agent in target directory
cd /path/to/project && claude "Build a dark mode toggle" &
PID=$!

# Monitor
wait $PID
echo "Agent finished with exit code $?"
```

## Parallel Issue Fixing with git worktrees

Fix multiple issues simultaneously:

```bash
# 1. Create worktrees for each issue
git worktree add -b fix/issue-78 /tmp/issue-78 main
git worktree add -b fix/issue-99 /tmp/issue-99 main

# 2. Launch agents in each
cd /tmp/issue-78 && npm install && codex exec --full-auto "Fix issue #78: <description>"
cd /tmp/issue-99 && npm install && codex exec --full-auto "Fix issue #99: <description>"

# 3. Create PRs after fixes
cd /tmp/issue-78 && git push -u origin fix/issue-78
gh pr create --repo user/repo --head fix/issue-78 --title "fix: ..." --body "..."

# 4. Cleanup
git worktree remove /tmp/issue-78
git worktree remove /tmp/issue-99
```

## Codex CLI Flags

| Flag | Effect |
|------|--------|
| `exec "prompt"` | One-shot execution, exits when done |
| `--full-auto` | Sandboxed but auto-approves in workspace |

## Rules

1. Respect tool choice - if user asks for Codex, use Codex
2. Be patient - don't kill agents because they're "slow"
3. If an agent fails, report the error and ask for direction
4. Never silently take over work from a delegated agent
5. Report progress: what started, milestones, errors, completion
