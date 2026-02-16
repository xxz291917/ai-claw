---
name: github
description: "Interact with GitHub using the `gh` CLI. Use for pull requests, issues, CI runs, and API queries."
tags: [git, collaboration, ci-cd]
allowed-tools: Read, Grep, Glob, Bash
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

## Pull Requests

```bash
# List open PRs
gh pr list

# View PR details
gh pr view 55

# Create PR
gh pr create --title "Fix bug" --body "Description"

# Review and merge
gh pr review 55 --approve
gh pr merge 55 --squash
```

Check CI status on a PR:

```bash
gh pr checks 55 --repo owner/repo
```

## CI/CD Workflows

List recent workflow runs:

```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:

```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:

```bash
gh run view <run-id> --repo owner/repo --log-failed
```

Re-run failed jobs:

```bash
gh run rerun <run-id> --failed
```

## Issues

```bash
# List issues
gh issue list

# Create issue
gh issue create --title "Bug report" --body "Details"

# Close issue
gh issue close 123
```

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get PR with specific fields:

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

View PR comments:

```bash
gh api repos/owner/repo/pulls/55/comments
```

## JSON Output

Most commands support `--json` for structured output. You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
