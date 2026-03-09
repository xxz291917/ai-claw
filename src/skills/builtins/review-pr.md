---
name: review-pr
description: "Structured workflow for reviewing GitHub pull requests. Use when asked to review a PR or provide code review feedback."
tags: [code-review, quality, git]
allowed-tools: bash_exec, file_read
requires-env: [GH_TOKEN]
requires-bins: [gh]
---

# Pull Request Review

Perform a structured, read-only review of a GitHub pull request.

## Inputs

- Ask for PR number or URL if not provided.

## Safety

- Never push, merge, or modify code during review.
- Keep review read-only.

## Steps

### 1. Fetch PR metadata and diff

```bash
gh pr view <PR>
gh pr diff <PR>
gh pr checks <PR>
```

### 2. Analyze changes

- Check diff size: flag if > 500 lines changed
- Identify changed files: group by type (code, tests, docs, config)
- Look for risky patterns: database migrations, auth changes, breaking APIs

### 3. Code quality checks

- Read modified files for logic errors
- Verify test coverage: every changed function should have tests
- Check for code smells: long functions, deep nesting, duplicate code
- Ensure consistent style with existing code

### 4. Security review

- Look for hardcoded credentials or API keys
- Check input validation and sanitization
- Verify authentication/authorization changes
- Flag any `eval()` or `exec()` usage on untrusted input

### 5. Submit review

```bash
# Approve if all checks pass
gh pr review <PR> --approve --body "LGTM! Summary..."

# Request changes if issues found
gh pr review <PR> --request-changes --body "Issues found:
- Item 1
- Item 2"
```

## Output Format

Structure your review feedback as:

```
**Summary**: [1-2 sentence overview]

**Strengths**:
- [Positive aspects]

**Issues**:
- [ ] **High**: [Description]
- [ ] **Medium**: [Description]
- [ ] **Nit**: [Minor suggestion]

**Recommendation**: Approve / Request changes / Comment only
```

## Red Flags (always request changes)

- Database schema changes without migration rollback plan
- Authentication/authorization bypasses
- Disabled tests or commented-out test assertions
- Hardcoded secrets or credentials
- Breaking API changes without deprecation notice
