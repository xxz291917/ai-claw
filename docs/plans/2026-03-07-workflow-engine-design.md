# Workflow Engine Design

Date: 2026-03-07

## Summary

借鉴 OpenClaw Lobster 的确定性工作流思路，在 AI Claw 中实现一个轻量级混合工作流引擎（方案 C）。引擎作为独立模块通过 `extraTools` 机制接入，对现有代码几乎零侵入。

## Problem

当前 `hs-*` 技能（bug 分析、提交 PR、发布、流水线）是 Markdown 指令，AI 一步步调用 `bash_exec` 执行。问题：

1. **每步都过 LLM** — 慢且贵，确定性命令（git、npm、gh）不需要 LLM 编排
2. **无状态保证** — AI 可能跳步、遗漏、出错后无法恢复
3. **审批靠口头约定** — checkpoint 写在 Markdown 里，AI 可能跳过

## Design

### Step Types

| 类型 | 执行方式 | 过 LLM | 成本 |
|------|---------|--------|------|
| `command`（默认） | spawn shell 子进程 | 否 | ~0 |
| `llm` | 调用 provider.query() | 是 | 按 token |
| `approval` | 暂停，等用户通过 resume_workflow 确认 | 否 | ~0 |

### Skill Frontmatter Extension

在现有 skill `.md` 文件的 YAML frontmatter 中新增 `workflow` 字段：

```yaml
---
name: hs-release
description: 标准发布流程
tags: [release, workflow]
requires-bins: [git, gh, npm]
workflow:
  args:
    version:
      required: true
      description: 发布版本号
    branch:
      default: main

  steps:
    - id: check-branch
      command: git rev-parse --abbrev-ref HEAD
      expect: ${branch}

    - id: check-clean
      command: git status --porcelain
      expect: ""

    - id: test
      command: npm test

    - id: confirm-release
      approval:
        prompt: "测试通过，确认发布 v${version}？"

    - id: tag
      command: git tag v${version}

    - id: push
      command: git push origin ${branch} --tags

  on-failure: |
    流程在步骤 ${failed_step} 失败：
    ${error}
---
```

没有 `workflow` 字段的技能不受影响，完全兼容。

### LLM Step Example

```yaml
steps:
  - id: gather
    command: gh issue view ${issue_url} --json title,body,comments

  - id: analyze
    type: llm
    prompt: |
      根据以下 issue 信息分析 bug 根因，给出修复方案：
      ${gather.stdout}

  - id: confirm-plan
    approval:
      prompt: "分析结果：\n${analyze.result}\n\n确认修复方案？"

  - id: fix
    type: llm
    prompt: |
      按照以下方案修复代码：${analyze.result}
      使用 bash_exec 和 file_write 工具完成修复。

  - id: test
    command: npm test

  - id: create-pr
    command: gh pr create --title "fix: ${issue_url}" --body "${analyze.result}"
```

### Tools

两个新工具，通过 `UnifiedToolDef` 注册：

**`run_workflow`** — 启动工作流

```typescript
{
  name: "run_workflow",
  parameters: {
    workflow: string,                  // skill name
    args: Record<string, string>       // 工作流参数
  }
}
```

返回三种状态：

```jsonc
// 全部完成
{ "status": "completed", "steps": [{ "id": "check-branch", "ok": true, "stdout": "main" }, ...] }

// 暂停等审批
{ "status": "needs_approval", "prompt": "测试通过，确认发布 v1.2.0？", "token": "wf_abc123", "completed_steps": [...] }

// 失败
{ "status": "failed", "failed_step": "test", "error": "3 tests failed", "completed_steps": [...] }
```

**`resume_workflow`** — 继续或取消暂停的工作流

```typescript
{
  name: "resume_workflow",
  parameters: {
    token: string,       // resumeToken
    approve: boolean     // true=继续, false=取消
  }
}
```

### Module Structure

```
src/workflow/
  ├── types.ts         # WorkflowDefinition, WorkflowStep, WorkflowExecution
  ├── parser.ts        # 从 skill frontmatter 解析 workflow 定义
  ├── engine.ts        # WorkflowEngine — 执行、暂停、恢复、LLM 调用
  └── tools.ts         # createWorkflowTools() → UnifiedToolDef[]
```

### Execution Flow

```
run_workflow("hs-release", {version: "1.2.0"})
    │
    ├─ parser.ts: 加载 skill → 解析 frontmatter → WorkflowDefinition
    ├─ 变量替换: ${version} → "1.2.0"
    │
    ├─ Step: check-branch (command)
    │   └─ spawn("git rev-parse --abbrev-ref HEAD")
    │   └─ stdout="main", expect="main" → ok
    │
    ├─ Step: test (command)
    │   └─ spawn("npm test")
    │   └─ exitCode=0 → ok
    │
    ├─ Step: confirm-release (approval)
    │   └─ 生成 token, 持久化到 DB
    │   └─ 返回 {status: "needs_approval", prompt: "...", token: "wf_xxx"}
    │
    │   ... LLM 转述给用户，用户确认 ...
    │
    ├─ resume_workflow("wf_xxx", approve=true)
    │   └─ 从 DB 恢复执行上下文
    │
    ├─ Step: tag (command)
    │   └─ spawn("git tag v1.2.0") → ok
    │
    └─ Step: push (command)
        └─ spawn("git push origin main --tags") → ok
        └─ 返回 {status: "completed"}
```

### State Persistence

SQLite 新表 `workflow_executions`：

```sql
CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  current_step TEXT,
  step_results TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

- status: pending | running | paused | completed | failed | cancelled
- 审批无超时限制，可等待数天
- 已完成/已取消记录保留 30 天后清理
- 进程重启后从 DB 恢复 paused 状态的工作流

### Integration Points

对现有代码的改动：

```typescript
// 1. server.ts — 初始化引擎（~3 行）
import { WorkflowEngine } from "./workflow/engine.js";
import { createWorkflowTools } from "./workflow/tools.js";
const workflowEngine = new WorkflowEngine({ db, skillsDirs });

// 2. buildToolSuite opts.extraTools — 注入工具
const workflowTools = createWorkflowTools(workflowEngine);
// 传入 buildToolSuite 的 opts.extraTools 中

// 3. db.ts — 追加建表 migration
// 在 initDb() 中添加 workflow_executions 表
```

不改的东西：
- skill loader / frontmatter parser — 引擎自己读取和解析 workflow 字段
- skill-reader tool — get_skill 照常返回 markdown
- conversation.ts — 工具通过标准 UnifiedToolDef 接入
- channels — 引擎结果是 JSON，LLM 转述
- providers — llm 步骤通过传入的 provider 回调执行

### Variable System

- `${arg_name}` — 工作流参数替换
- `${step_id.stdout}` — 引用前序 command 步骤的 stdout
- `${step_id.result}` — 引用前序 llm 步骤的结果
- `${failed_step}` / `${error}` — on-failure 模板中可用

### Command Execution

复用 bash-exec 的 spawn 模式：
- 每步独立超时（默认 120s，可在步骤中覆盖 `timeout: 300`）
- 输出截断（默认 512KB）
- 环境清理（TERM=dumb）
- 继承 bash-exec 的 allowedCommands（如果配置了）

### Security

- command 步骤继承 bash-exec 的沙箱规则（allowlist、metachar blocking）
- llm 步骤使用与主对话相同的 provider 和 tool 权限
- 工作流只能由认证用户触发（通过 ToolContext.userId）
- resume 时校验 userId 一致性

### Concurrency

- 同一 session 同时只能有一个活跃工作流（running 或 paused）
- 新工作流启动时检查是否有活跃的，有则拒绝并提示

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a lightweight hybrid workflow engine that executes deterministic shell steps without LLM, supports LLM steps on demand, and pauses at approval gates with persistent state.

**Architecture:** Independent `src/workflow/` module exposing `UnifiedToolDef[]` via `createWorkflowTools()`. Injected into `buildToolSuite` through existing `extraTools` mechanism. State persisted in SQLite `workflow_executions` table.

**Tech Stack:** TypeScript, better-sqlite3, node:child_process spawn, existing UnifiedToolDef/ToolContext patterns.

---

### Task 1: Types — WorkflowDefinition, WorkflowStep, WorkflowExecution

**Files:**
- Create: `src/workflow/types.ts`
- Test: `test/workflow/types.test.ts`

**Step 1: Write the type definitions**

```typescript
// src/workflow/types.ts

/** Workflow argument definition from frontmatter */
export type WorkflowArgDef = {
  required?: boolean;
  default?: string;
  description?: string;
};

/** A single step in a workflow definition */
export type WorkflowStep =
  | { id: string; command: string; expect?: string; timeout?: number }
  | { id: string; type: "llm"; prompt: string }
  | { id: string; approval: { prompt: string } };

/** Parsed workflow definition from skill frontmatter */
export type WorkflowDefinition = {
  name: string;
  args: Record<string, WorkflowArgDef>;
  steps: WorkflowStep[];
  onFailure?: string;
};

/** Result of a completed step */
export type StepResult = {
  id: string;
  ok: boolean;
  stdout?: string;
  result?: string;
  error?: string;
};

/** Persisted execution state */
export type WorkflowExecution = {
  id: string;
  workflowName: string;
  userId: string;
  sessionId: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled";
  args: Record<string, string>;
  currentStep: string | null;
  stepResults: StepResult[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Return value from engine.run() and engine.resume() */
export type WorkflowResult =
  | { status: "completed"; steps: StepResult[] }
  | { status: "needs_approval"; prompt: string; token: string; completed_steps: StepResult[] }
  | { status: "failed"; failed_step: string; error: string; completed_steps: StepResult[] };

/** Helper to classify step type */
export function stepType(step: WorkflowStep): "command" | "llm" | "approval" {
  if ("approval" in step) return "approval";
  if ("type" in step && step.type === "llm") return "llm";
  return "command";
}
```

**Step 2: Write a simple type assertion test**

```typescript
// test/workflow/types.test.ts
import { describe, it, expect } from "vitest";
import { stepType } from "../../src/workflow/types.js";
import type { WorkflowStep } from "../../src/workflow/types.js";

describe("stepType", () => {
  it("identifies command steps", () => {
    const step: WorkflowStep = { id: "s1", command: "git status" };
    expect(stepType(step)).toBe("command");
  });

  it("identifies llm steps", () => {
    const step: WorkflowStep = { id: "s2", type: "llm", prompt: "analyze" };
    expect(stepType(step)).toBe("llm");
  });

  it("identifies approval steps", () => {
    const step: WorkflowStep = { id: "s3", approval: { prompt: "ok?" } };
    expect(stepType(step)).toBe("approval");
  });
});
```

**Step 3: Run test to verify it passes**

Run: `npx vitest run test/workflow/types.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/workflow/types.ts test/workflow/types.test.ts
git commit -m "feat(workflow): add type definitions for workflow engine"
```

---

### Task 2: Parser — extract workflow from skill frontmatter

**Files:**
- Create: `src/workflow/parser.ts`
- Test: `test/workflow/parser.test.ts`

**Step 1: Write the failing test**

```typescript
// test/workflow/parser.test.ts
import { describe, it, expect } from "vitest";
import { parseWorkflowFromSkill } from "../../src/workflow/parser.js";

const SKILL_CONTENT = `---
name: test-release
description: Test release workflow
tags: [release]
requires-bins: [git]
workflow:
  args:
    version:
      required: true
    branch:
      default: main
  steps:
    - id: check
      command: git status --porcelain
      expect: ""
    - id: confirm
      approval:
        prompt: "确认发布 v\${version}？"
    - id: tag
      command: git tag v\${version}
  on-failure: "步骤 \${failed_step} 失败: \${error}"
---

# Test Release

This is the skill body.
`;

describe("parseWorkflowFromSkill", () => {
  it("returns null for skills without workflow field", () => {
    const content = "---\nname: simple\ndescription: no workflow\n---\n# Simple";
    expect(parseWorkflowFromSkill(content)).toBeNull();
  });

  it("parses workflow definition from frontmatter", () => {
    const wf = parseWorkflowFromSkill(SKILL_CONTENT);
    expect(wf).not.toBeNull();
    expect(wf!.name).toBe("test-release");
    expect(wf!.args.version.required).toBe(true);
    expect(wf!.args.branch.default).toBe("main");
    expect(wf!.steps).toHaveLength(3);
    expect(wf!.steps[0]).toEqual({ id: "check", command: "git status --porcelain", expect: "" });
    expect(wf!.steps[1]).toEqual({ id: "confirm", approval: { prompt: "确认发布 v${version}？" } });
    expect(wf!.steps[2]).toEqual({ id: "tag", command: "git tag v${version}" });
    expect(wf!.onFailure).toBe("步骤 ${failed_step} 失败: ${error}");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/parser.test.ts`
Expected: FAIL — module not found

**Step 3: Write the parser**

The existing `parseSimpleYaml` in `src/skills/frontmatter.ts` only handles flat key-value pairs — it cannot parse nested `workflow:` with `args:`, `steps:`, etc. Instead of extending that fragile parser, use a lightweight approach: detect the `workflow:` block boundaries in the raw YAML string and parse it with `JSON.parse` after a simple YAML-to-JSON conversion — or better, use a small dedicated YAML parser.

Since the project avoids external deps for parsing, and the workflow YAML has predictable structure, use a pragmatic approach: store workflow definitions as **JSON within the frontmatter** (a single `workflow:` key whose value is a JSON string), or parse the indented YAML block manually.

Best approach: **extract the workflow block as indented text from frontmatter, then parse it with a purpose-built parser that handles the specific workflow schema** (args dict, steps array with known keys).

```typescript
// src/workflow/parser.ts
import { readFileSync } from "node:fs";
import type { WorkflowDefinition, WorkflowStep, WorkflowArgDef } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?\r?\n)---/;

/**
 * Parse workflow definition from a skill file's content.
 * Returns null if the skill has no workflow field.
 */
export function parseWorkflowFromSkill(content: string): WorkflowDefinition | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const yaml = match[1];
  const name = extractScalar(yaml, "name") ?? "unnamed";

  // Check if workflow section exists
  const workflowBlock = extractBlock(yaml, "workflow");
  if (!workflowBlock) return null;

  const argsBlock = extractBlock(workflowBlock, "args");
  const args = argsBlock ? parseArgs(argsBlock) : {};

  const steps = parseSteps(workflowBlock);
  const onFailure = extractScalar(workflowBlock, "on-failure") ?? undefined;

  return { name, args, steps, onFailure };
}

/**
 * Load and parse a workflow from a skill file path.
 */
export function loadWorkflowFromFile(filePath: string): WorkflowDefinition | null {
  const content = readFileSync(filePath, "utf-8");
  return parseWorkflowFromSkill(content);
}

/** Extract a top-level scalar value like `name: foo` */
function extractScalar(yaml: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = yaml.match(re);
  if (!m) return null;
  let val = m[1].trim();
  // Strip quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  // Handle multi-line | syntax
  if (val === "|") {
    return extractMultilineScalar(yaml, key);
  }
  return val;
}

/** Extract a multi-line scalar (| syntax) */
function extractMultilineScalar(yaml: string, key: string): string | null {
  const lines = yaml.split("\n");
  let collecting = false;
  let indent = 0;
  const result: string[] = [];

  for (const line of lines) {
    if (!collecting) {
      const re = new RegExp(`^(\\s*)${key}:\\s*\\|\\s*$`);
      const m = line.match(re);
      if (m) {
        collecting = true;
        indent = m[1].length + 2; // expect 2 more spaces of indentation
      }
      continue;
    }
    // Collecting: stop at line with <= parent indentation (non-empty)
    if (line.trim() === "") {
      result.push("");
      continue;
    }
    const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (lineIndent < indent) break;
    result.push(line.slice(indent));
  }

  return result.length > 0 ? result.join("\n").trimEnd() : null;
}

/** Extract an indented block under a key */
function extractBlock(yaml: string, key: string): string | null {
  const lines = yaml.split("\n");
  let start = -1;
  let keyIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(`^(\\s*)${key}:\\s*$`);
    const m = lines[i].match(re);
    if (m) {
      start = i + 1;
      keyIndent = m[1].length;
      break;
    }
  }
  if (start === -1) return null;

  const result: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      result.push("");
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= keyIndent) break;
    result.push(line);
  }

  return result.join("\n");
}

/** Parse args block into Record<string, WorkflowArgDef> */
function parseArgs(block: string): Record<string, WorkflowArgDef> {
  const args: Record<string, WorkflowArgDef> = {};
  const lines = block.split("\n");
  let currentArg: string | null = null;

  for (const line of lines) {
    if (line.trim() === "") continue;

    // Arg name line (e.g., "    version:")
    const argMatch = line.match(/^\s{4}(\w[\w-]*):\s*$/);
    if (argMatch) {
      currentArg = argMatch[1];
      args[currentArg] = {};
      continue;
    }

    // Arg property line (e.g., "      required: true")
    if (currentArg) {
      const propMatch = line.match(/^\s{6,}(\w[\w-]*):\s*(.+)$/);
      if (propMatch) {
        const [, prop, val] = propMatch;
        const trimmedVal = val.trim();
        if (prop === "required") {
          args[currentArg].required = trimmedVal === "true";
        } else if (prop === "default") {
          args[currentArg].default = stripQuotes(trimmedVal);
        } else if (prop === "description") {
          args[currentArg].description = stripQuotes(trimmedVal);
        }
      }
    }
  }

  return args;
}

/** Parse steps array from workflow block */
function parseSteps(workflowBlock: string): WorkflowStep[] {
  const stepsBlock = extractBlock(workflowBlock, "steps");
  if (!stepsBlock) return [];

  const steps: WorkflowStep[] = [];
  const lines = stepsBlock.split("\n");
  let current: Record<string, any> | null = null;
  let collectingPrompt = false;
  let promptLines: string[] = [];
  let promptKey: string = "";
  let promptIndent = 0;

  const flushPrompt = () => {
    if (collectingPrompt && current) {
      const text = promptLines.join("\n").trimEnd();
      if (promptKey === "approval-prompt") {
        current.approval = { prompt: text };
      } else {
        current.prompt = text;
      }
      collectingPrompt = false;
      promptLines = [];
    }
  };

  const flushStep = () => {
    flushPrompt();
    if (current?.id) {
      steps.push(buildStep(current));
    }
    current = null;
  };

  for (const line of lines) {
    // New list item: "    - id: xxx"
    const itemMatch = line.match(/^(\s*)-\s+id:\s*(.+)$/);
    if (itemMatch) {
      flushStep();
      current = { id: itemMatch[2].trim() };
      continue;
    }

    if (!current) continue;

    // If collecting multi-line prompt
    if (collectingPrompt) {
      const lineIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (line.trim() === "" || lineIndent >= promptIndent) {
        promptLines.push(line.trim() === "" ? "" : line.slice(promptIndent));
        continue;
      } else {
        flushPrompt();
        // Fall through to parse this line normally
      }
    }

    const propMatch = line.match(/^\s+(\w[\w-]*):\s*(.*)$/);
    if (!propMatch) continue;
    const [, key, rawVal] = propMatch;
    const val = rawVal.trim();

    if (key === "command") {
      current.command = stripQuotes(val);
    } else if (key === "expect") {
      current.expect = stripQuotes(val);
    } else if (key === "timeout") {
      current.timeout = parseInt(val, 10);
    } else if (key === "type") {
      current.type = val;
    } else if (key === "prompt") {
      if (val === "|") {
        collectingPrompt = true;
        promptKey = "prompt";
        promptIndent = (line.match(/^(\s*)/)?.[1].length ?? 0) + 2;
        promptLines = [];
      } else {
        current.prompt = stripQuotes(val);
      }
    } else if (key === "approval") {
      // "approval:" line — next lines have prompt
    }

    // Handle approval > prompt nested
    if (key === "prompt" && !current.command && !current.type && !("prompt" in current)) {
      // This is under approval:
      if (val === "|") {
        collectingPrompt = true;
        promptKey = "approval-prompt";
        promptIndent = (line.match(/^(\s*)/)?.[1].length ?? 0) + 2;
        promptLines = [];
      } else {
        current.approval = { prompt: stripQuotes(val) };
      }
    }
  }

  flushStep();
  return steps;
}

function buildStep(raw: Record<string, any>): WorkflowStep {
  if (raw.approval) {
    return { id: raw.id, approval: raw.approval };
  }
  if (raw.type === "llm") {
    return { id: raw.id, type: "llm", prompt: raw.prompt ?? "" };
  }
  const step: any = { id: raw.id, command: raw.command ?? "" };
  if (raw.expect !== undefined) step.expect = raw.expect;
  if (raw.timeout !== undefined) step.timeout = raw.timeout;
  return step;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/parser.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/parser.ts test/workflow/parser.test.ts
git commit -m "feat(workflow): add workflow definition parser from skill frontmatter"
```

---

### Task 3: DB schema — workflow_executions table

**Files:**
- Modify: `src/db.ts:101-107` (add table after user_settings)
- Test: `test/workflow/engine.test.ts` (created in Task 4, verified here)

**Step 1: Add migration to initDb()**

In `src/db.ts`, append to the `db.exec()` block (before the closing `\`);`):

```sql
    CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      args TEXT NOT NULL DEFAULT '{}',
      current_step TEXT,
      step_results TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_executions_session
      ON workflow_executions(session_id, status);
```

**Step 2: Verify existing tests still pass**

Run: `npx vitest run`
Expected: All existing tests PASS (new table is additive)

**Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat(workflow): add workflow_executions table to DB schema"
```

---

### Task 4: Engine — core execution, approval pause, resume

**Files:**
- Create: `src/workflow/engine.ts`
- Test: `test/workflow/engine.test.ts`

**Step 1: Write the failing tests**

```typescript
// test/workflow/engine.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { createTestDb } from "../helpers.js";
import type { WorkflowDefinition } from "../../src/workflow/types.js";
import type Database from "better-sqlite3";

const SIMPLE_WORKFLOW: WorkflowDefinition = {
  name: "test-wf",
  args: {},
  steps: [
    { id: "echo", command: "echo hello" },
  ],
};

const APPROVAL_WORKFLOW: WorkflowDefinition = {
  name: "approval-wf",
  args: { version: { required: true } },
  steps: [
    { id: "check", command: "echo ok" },
    { id: "confirm", approval: { prompt: "Deploy v${version}?" } },
    { id: "deploy", command: "echo deployed" },
  ],
};

const EXPECT_WORKFLOW: WorkflowDefinition = {
  name: "expect-wf",
  args: {},
  steps: [
    { id: "branch", command: "echo main", expect: "main" },
  ],
};

const EXPECT_FAIL_WORKFLOW: WorkflowDefinition = {
  name: "expect-fail-wf",
  args: {},
  steps: [
    { id: "branch", command: "echo develop", expect: "main" },
  ],
};

describe("WorkflowEngine", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new WorkflowEngine({ db });
  });

  it("runs a simple command workflow to completion", async () => {
    const result = await engine.run(SIMPLE_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].ok).toBe(true);
      expect(result.steps[0].stdout).toContain("hello");
    }
  });

  it("pauses at approval gate and resumes", async () => {
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "1.0" },
      { userId: "alice", sessionId: "s1" },
    );
    expect(result.status).toBe("needs_approval");
    if (result.status !== "needs_approval") return;
    expect(result.prompt).toBe("Deploy v1.0?");
    expect(result.token).toBeTruthy();
    expect(result.completed_steps).toHaveLength(1);

    // Resume with approval
    const resumed = await engine.resume(result.token, true, "alice");
    expect(resumed.status).toBe("completed");
    if (resumed.status === "completed") {
      expect(resumed.steps).toHaveLength(3); // check + confirm(approval) + deploy
    }
  });

  it("cancels workflow on resume with approve=false", async () => {
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "2.0" },
      { userId: "alice", sessionId: "s1" },
    );
    expect(result.status).toBe("needs_approval");
    if (result.status !== "needs_approval") return;

    const cancelled = await engine.resume(result.token, false, "alice");
    expect(cancelled.status).toBe("failed");
    if (cancelled.status === "failed") {
      expect(cancelled.failed_step).toBe("confirm");
    }
  });

  it("rejects resume with wrong userId", async () => {
    const result = await engine.run(
      APPROVAL_WORKFLOW,
      { version: "1.0" },
      { userId: "alice", sessionId: "s1" },
    );
    if (result.status !== "needs_approval") return;
    await expect(engine.resume(result.token, true, "bob")).rejects.toThrow();
  });

  it("validates expect field", async () => {
    const result = await engine.run(EXPECT_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("completed");
  });

  it("fails when expect does not match", async () => {
    const result = await engine.run(EXPECT_FAIL_WORKFLOW, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failed_step).toBe("branch");
    }
  });

  it("substitutes ${arg} and ${step.stdout} variables", async () => {
    const wf: WorkflowDefinition = {
      name: "vars-wf",
      args: { name: { required: true } },
      steps: [
        { id: "greet", command: "echo hello-${name}" },
        { id: "use", command: "echo ${greet.stdout}" },
      ],
    };
    const result = await engine.run(wf, { name: "world" }, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.steps[0].stdout).toContain("hello-world");
      expect(result.steps[1].stdout).toContain("hello-world");
    }
  });

  it("fails on command exit code != 0", async () => {
    const wf: WorkflowDefinition = {
      name: "fail-wf",
      args: {},
      steps: [{ id: "bad", command: "exit 1" }],
    };
    const result = await engine.run(wf, {}, { userId: "alice", sessionId: "s1" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failed_step).toBe("bad");
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/engine.test.ts`
Expected: FAIL — module not found

**Step 3: Write the engine**

```typescript
// src/workflow/engine.ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowExecution,
  WorkflowResult,
  StepResult,
} from "./types.js";
import { stepType } from "./types.js";

type EngineOpts = {
  db: Database.Database;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
  /** Callback for LLM steps — injected by tools.ts at registration time */
  llmHandler?: (prompt: string, ctx: { userId: string; sessionId: string }) => Promise<string>;
};

export class WorkflowEngine {
  private db: Database.Database;
  private defaultTimeoutMs: number;
  private maxOutputChars: number;
  private llmHandler?: EngineOpts["llmHandler"];

  constructor(opts: EngineOpts) {
    this.db = opts.db;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.maxOutputChars = opts.maxOutputChars ?? 512_000;
    this.llmHandler = opts.llmHandler;
  }

  setLlmHandler(handler: EngineOpts["llmHandler"]): void {
    this.llmHandler = handler;
  }

  /** Start a workflow execution */
  async run(
    definition: WorkflowDefinition,
    args: Record<string, string>,
    ctx: { userId: string; sessionId: string },
  ): Promise<WorkflowResult> {
    // Validate required args
    for (const [name, def] of Object.entries(definition.args)) {
      if (def.required && !(name in args)) {
        return {
          status: "failed",
          failed_step: "(args)",
          error: `Missing required argument: ${name}`,
          completed_steps: [],
        };
      }
      // Apply defaults
      if (!(name in args) && def.default !== undefined) {
        args[name] = def.default;
      }
    }

    const id = "wf_" + randomBytes(8).toString("hex");

    this.dbInsert(id, definition.name, ctx.userId, ctx.sessionId, args);

    return this.executeSteps(id, definition, args, 0, [], ctx);
  }

  /** Resume a paused workflow */
  async resume(
    token: string,
    approve: boolean,
    userId: string,
  ): Promise<WorkflowResult> {
    const exec = this.dbGet(token);
    if (!exec) throw new Error(`Workflow not found: ${token}`);
    if (exec.status !== "paused") throw new Error(`Workflow is not paused (status: ${exec.status})`);
    if (exec.userId !== userId) throw new Error("Permission denied: userId mismatch");

    if (!approve) {
      this.dbUpdate(token, "cancelled", exec.currentStep, exec.stepResults, "User cancelled");
      return {
        status: "failed",
        failed_step: exec.currentStep ?? "unknown",
        error: "User cancelled",
        completed_steps: exec.stepResults,
      };
    }

    // Mark the approval step as done
    const approvalResult: StepResult = { id: exec.currentStep!, ok: true };
    const stepResults = [...exec.stepResults, approvalResult];

    // Find next step index
    // Need to re-parse the workflow to get step definitions
    // Store definition name, look up from caller — for now, re-load isn't needed
    // because we store enough state. We need the definition though.
    // The definition is not stored in DB (it's in the skill file).
    // We need to pass it or re-load it.
    // For simplicity, store the full steps JSON in the execution record.

    this.dbUpdate(token, "running", null, stepResults, null);

    // We need the full definition to continue. Store steps in DB as well.
    // Actually, let's store the workflow definition JSON alongside.
    const defJson = this.dbGetDefinition(token);
    if (!defJson) throw new Error("Workflow definition not found in DB");
    const definition: WorkflowDefinition = JSON.parse(defJson);

    // Find the index of the step after the approval
    const currentIdx = definition.steps.findIndex((s) => s.id === exec.currentStep);
    if (currentIdx === -1) throw new Error(`Step not found: ${exec.currentStep}`);

    return this.executeSteps(
      token,
      definition,
      exec.args,
      currentIdx + 1,
      stepResults,
      { userId: exec.userId, sessionId: exec.sessionId },
    );
  }

  /** Execute steps starting from startIdx */
  private async executeSteps(
    execId: string,
    definition: WorkflowDefinition,
    args: Record<string, string>,
    startIdx: number,
    previousResults: StepResult[],
    ctx: { userId: string; sessionId: string },
  ): Promise<WorkflowResult> {
    const results = [...previousResults];

    for (let i = startIdx; i < definition.steps.length; i++) {
      const step = definition.steps[i];
      const type = stepType(step);

      this.dbUpdate(execId, "running", step.id, results, null);

      if (type === "approval") {
        const approvalStep = step as { id: string; approval: { prompt: string } };
        const prompt = this.substituteVars(approvalStep.approval.prompt, args, results);

        // Store definition for resume
        this.dbStoreDefinition(execId, JSON.stringify(definition));
        this.dbUpdate(execId, "paused", step.id, results, null);

        return {
          status: "needs_approval",
          prompt,
          token: execId,
          completed_steps: results,
        };
      }

      if (type === "llm") {
        const llmStep = step as { id: string; type: "llm"; prompt: string };
        if (!this.llmHandler) {
          this.dbUpdate(execId, "failed", step.id, results, "LLM handler not configured");
          return {
            status: "failed",
            failed_step: step.id,
            error: "LLM handler not configured",
            completed_steps: results,
          };
        }
        try {
          const prompt = this.substituteVars(llmStep.prompt, args, results);
          const result = await this.llmHandler(prompt, ctx);
          results.push({ id: step.id, ok: true, result });
        } catch (err: any) {
          const error = err.message ?? String(err);
          this.dbUpdate(execId, "failed", step.id, results, error);
          return {
            status: "failed",
            failed_step: step.id,
            error,
            completed_steps: results,
          };
        }
        continue;
      }

      // Command step
      const cmdStep = step as { id: string; command: string; expect?: string; timeout?: number };
      const command = this.substituteVars(cmdStep.command, args, results);
      const timeoutMs = (cmdStep.timeout ?? 120) * 1000;

      try {
        const { stdout, exitCode } = await this.execCommand(command, timeoutMs);
        const trimmedStdout = stdout.trim();

        // Check expect
        if (cmdStep.expect !== undefined) {
          const expected = this.substituteVars(cmdStep.expect, args, results).trim();
          if (trimmedStdout !== expected) {
            const error = `Expected "${expected}" but got "${trimmedStdout}"`;
            results.push({ id: step.id, ok: false, stdout: trimmedStdout, error });
            this.dbUpdate(execId, "failed", step.id, results, error);
            return {
              status: "failed",
              failed_step: step.id,
              error,
              completed_steps: results,
            };
          }
        }

        if (exitCode !== 0) {
          const error = `Command exited with code ${exitCode}: ${trimmedStdout}`;
          results.push({ id: step.id, ok: false, stdout: trimmedStdout, error });
          this.dbUpdate(execId, "failed", step.id, results, error);
          return {
            status: "failed",
            failed_step: step.id,
            error,
            completed_steps: results,
          };
        }

        results.push({ id: step.id, ok: true, stdout: trimmedStdout });
      } catch (err: any) {
        const error = err.message ?? String(err);
        results.push({ id: step.id, ok: false, error });
        this.dbUpdate(execId, "failed", step.id, results, error);
        return {
          status: "failed",
          failed_step: step.id,
          error,
          completed_steps: results,
        };
      }
    }

    this.dbUpdate(execId, "completed", null, results, null);
    return { status: "completed", steps: results };
  }

  /** Variable substitution: ${arg}, ${step.stdout}, ${step.result} */
  private substituteVars(
    template: string,
    args: Record<string, string>,
    results: StepResult[],
  ): string {
    return template.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
      // ${arg_name}
      if (expr in args) return args[expr];

      // ${step_id.stdout} or ${step_id.result}
      const dotIdx = expr.indexOf(".");
      if (dotIdx !== -1) {
        const stepId = expr.slice(0, dotIdx);
        const field = expr.slice(dotIdx + 1);
        const stepResult = results.find((r) => r.id === stepId);
        if (stepResult) {
          if (field === "stdout" && stepResult.stdout !== undefined) return stepResult.stdout;
          if (field === "result" && stepResult.result !== undefined) return stepResult.result;
        }
      }

      return match; // Leave unresolved
    });
  }

  /** Execute a shell command (simplified from bash-exec) */
  private execCommand(
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb", CUPS_SERVER: "" },
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, exitCode });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        if (stdout.length < this.maxOutputChars) {
          stdout += text.slice(0, this.maxOutputChars - stdout.length);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("close", (code) => finish(code ?? 0));

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { process.kill(-child.pid!, "SIGKILL"); } catch {}
          resolve({ stdout, exitCode: 137 });
        }
      }, timeoutMs);
    });
  }

  // --- DB helpers ---

  private dbInsert(
    id: string, workflowName: string, userId: string, sessionId: string,
    args: Record<string, string>,
  ): void {
    this.db.prepare(`
      INSERT INTO workflow_executions (id, workflow_name, user_id, session_id, status, args)
      VALUES (?, ?, ?, ?, 'running', ?)
    `).run(id, workflowName, userId, sessionId, JSON.stringify(args));
  }

  private dbUpdate(
    id: string, status: string, currentStep: string | null,
    stepResults: StepResult[], error: string | null,
  ): void {
    this.db.prepare(`
      UPDATE workflow_executions
      SET status = ?, current_step = ?, step_results = ?, error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status, currentStep, JSON.stringify(stepResults), error, id);
  }

  private dbGet(id: string): WorkflowExecution | null {
    const row = this.db.prepare(`SELECT * FROM workflow_executions WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      ...row,
      args: JSON.parse(row.args),
      stepResults: JSON.parse(row.step_results),
    };
  }

  private dbStoreDefinition(id: string, definitionJson: string): void {
    // Store in the args field alongside user args — use a reserved key
    const row = this.db.prepare(`SELECT args FROM workflow_executions WHERE id = ?`).get(id) as any;
    if (!row) return;
    const args = JSON.parse(row.args);
    args.__definition = definitionJson;
    this.db.prepare(`UPDATE workflow_executions SET args = ? WHERE id = ?`)
      .run(JSON.stringify(args), id);
  }

  private dbGetDefinition(id: string): string | null {
    const row = this.db.prepare(`SELECT args FROM workflow_executions WHERE id = ?`).get(id) as any;
    if (!row) return null;
    const args = JSON.parse(row.args);
    return args.__definition ?? null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/engine.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/engine.ts test/workflow/engine.test.ts
git commit -m "feat(workflow): add workflow engine with command execution, approval gates, and variable substitution"
```

---

### Task 5: Tools — run_workflow and resume_workflow as UnifiedToolDef

**Files:**
- Create: `src/workflow/tools.ts`
- Test: `test/workflow/tools.test.ts`

**Step 1: Write the failing test**

```typescript
// test/workflow/tools.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createWorkflowTools } from "../../src/workflow/tools.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";
import { createTestDb } from "../helpers.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";

const SKILL_CONTENT = `---
name: echo-wf
description: Simple echo workflow
workflow:
  args:
    msg:
      required: true
  steps:
    - id: echo
      command: echo \${msg}
---
# Echo Workflow
`;

describe("createWorkflowTools", () => {
  let db: Database.Database;
  let engine: WorkflowEngine;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    tmpDir = resolve("/tmp/wf-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(resolve(tmpDir, "echo-wf.md"), SKILL_CONTENT);
    engine = new WorkflowEngine({ db });
  });

  it("creates run_workflow and resume_workflow tools", () => {
    const tools = createWorkflowTools(engine, [tmpDir]);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("run_workflow");
    expect(tools[1].name).toBe("resume_workflow");
  });

  it("run_workflow executes a simple workflow", async () => {
    const tools = createWorkflowTools(engine, [tmpDir]);
    const runTool = tools[0];
    const result = await runTool.execute(
      { workflow: "echo-wf", args: JSON.stringify({ msg: "hi" }) },
      { userId: "alice", sessionId: "s1" },
    );
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("completed");
    expect(parsed.steps[0].stdout).toContain("hi");
  });

  it("returns error for unknown workflow", async () => {
    const tools = createWorkflowTools(engine, [tmpDir]);
    const runTool = tools[0];
    const result = await runTool.execute(
      { workflow: "nonexistent", args: "{}" },
      { userId: "alice", sessionId: "s1" },
    );
    expect(result).toContain("Error");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/workflow/tools.test.ts`
Expected: FAIL — module not found

**Step 3: Write tools.ts**

```typescript
// src/workflow/tools.ts
import { z } from "zod";
import type { UnifiedToolDef } from "../tools/types.js";
import type { WorkflowEngine } from "./engine.js";
import { parseWorkflowFromSkill } from "./parser.js";
import { scanSkillDirs } from "../skills/loader.js";
import { readFileSync } from "node:fs";

/**
 * Create run_workflow and resume_workflow tools.
 * Injected into buildToolSuite via extraTools.
 */
export function createWorkflowTools(
  engine: WorkflowEngine,
  skillsDirs: string[],
): UnifiedToolDef[] {
  // Scan for workflow-enabled skills to build description
  const allSkills = scanSkillDirs(skillsDirs);
  const workflowSkills = allSkills
    .filter((s) => {
      try {
        const content = readFileSync(s.path, "utf-8");
        return parseWorkflowFromSkill(content) !== null;
      } catch { return false; }
    })
    .map((s) => s.name);

  const workflowList = workflowSkills.length > 0
    ? `Available workflows: ${workflowSkills.join(", ")}`
    : "No workflow-enabled skills found";

  const runWorkflow: UnifiedToolDef = {
    name: "run_workflow",
    description:
      `Execute a deterministic workflow defined in a skill file. ` +
      `Command steps run as shell subprocesses without LLM. ` +
      `Approval steps pause and return a token for user confirmation. ` +
      workflowList,
    inputSchema: {
      workflow: z.string().describe("Skill name (e.g. 'hs-release')"),
      args: z.string().optional().describe("JSON string of workflow arguments"),
    },
    parameters: {
      type: "object",
      properties: {
        workflow: { type: "string", description: "Skill name (e.g. 'hs-release')" },
        args: { type: "string", description: "JSON string of workflow arguments" },
      },
      required: ["workflow"],
    },
    execute: async (input: { workflow: string; args?: string }, ctx) => {
      try {
        // Find the skill file
        const allSkills = scanSkillDirs(skillsDirs);
        const skill = allSkills.find((s) => s.name === input.workflow);
        if (!skill) return `Error: Workflow "${input.workflow}" not found`;

        const content = readFileSync(skill.path, "utf-8");
        const definition = parseWorkflowFromSkill(content);
        if (!definition) return `Error: Skill "${input.workflow}" has no workflow definition`;

        const args = input.args ? JSON.parse(input.args) : {};
        const result = await engine.run(definition, args, ctx);
        return JSON.stringify(result, null, 2);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };

  const resumeWorkflow: UnifiedToolDef = {
    name: "resume_workflow",
    description:
      "Resume a paused workflow after user approval. " +
      "Pass the token from a previous run_workflow result and the user's decision.",
    inputSchema: {
      token: z.string().describe("Resume token from needs_approval result"),
      approve: z.boolean().describe("true to continue, false to cancel"),
    },
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "Resume token from needs_approval result" },
        approve: { type: "boolean", description: "true to continue, false to cancel" },
      },
      required: ["token", "approve"],
    },
    execute: async (input: { token: string; approve: boolean }, ctx) => {
      try {
        const result = await engine.resume(input.token, input.approve, ctx.userId);
        return JSON.stringify(result, null, 2);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };

  return [runWorkflow, resumeWorkflow];
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/workflow/tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/workflow/tools.ts test/workflow/tools.test.ts
git commit -m "feat(workflow): add run_workflow and resume_workflow tools"
```

---

### Task 6: Integration — wire into server.ts

**Files:**
- Modify: `src/server.ts:97-102` (inject workflow tools into extraTools)

**Step 1: Add imports and initialize engine**

At the top of `src/server.ts`, add imports:

```typescript
import { WorkflowEngine } from "./workflow/engine.js";
import { createWorkflowTools } from "./workflow/tools.js";
```

After the SubagentManager creation (around line 95) and before `buildToolSuite` (line 98), add:

```typescript
  // --- Workflow Engine ---
  const workflowEngine = new WorkflowEngine({ db });
```

**Step 2: Inject workflow tools into extraTools**

Change the `buildToolSuite` call (line 98-102) to merge workflow tools with MCP bridge tools:

```typescript
  const workflowTools = createWorkflowTools(workflowEngine, skillsDirs);
  const toolSuite = buildToolSuite(env, skillsDirs, memoryManager, {
    subagentManager,
    defaultProvider: env.CHAT_PROVIDER,
    extraTools: [...mcpBridge.tools, ...workflowTools],
  });
```

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Manual smoke test**

Run: `npm run dev`
Expected: Server starts without errors. `run_workflow` and `resume_workflow` appear in tool list.

**Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat(workflow): wire workflow engine into server startup"
```

---

### Task 7: Sample workflow skill — convert hs-release to workflow format

**Files:**
- Create: `src/skills/hs-release-wf.md` (new workflow-enabled version alongside existing)

**Step 1: Create the workflow skill**

Create `src/skills/hs-release-wf.md` as a workflow-enabled version of `hs-release`. Keep the original `hs-release.md` unchanged for now.

```markdown
---
name: hs-release-wf
description: 标准发布流程（工作流版本）— 自动执行 git 检查、测试、打 tag、推送
tags: [release, workflow]
requires-bins: [git, npm]
workflow:
  args:
    version:
      required: true
      description: 发布版本号（如 1.2.0）
    branch:
      default: main
  steps:
    - id: check-branch
      command: git rev-parse --abbrev-ref HEAD
      expect: ${branch}
    - id: check-clean
      command: git status --porcelain
      expect: ""
    - id: test
      command: npm test
    - id: confirm-release
      approval:
        prompt: "分支: ${branch}, 测试通过, 确认发布 v${version}？"
    - id: tag
      command: git tag v${version}
    - id: push
      command: git push origin ${branch} --tags
  on-failure: "步骤 ${failed_step} 失败: ${error}"
---

# hs-release-wf

标准发布流程的工作流版本。使用 `run_workflow` 工具执行，命令步骤自动运行，仅在打 tag 前暂停确认。

## 使用方式

AI 会自动调用：
```json
{ "workflow": "hs-release-wf", "args": "{\"version\": \"1.2.0\"}" }
```
```

**Step 2: Verify the skill is discovered**

Run: `npm run dev` → check logs for `hs-release-wf` in skill list.

**Step 3: Commit**

```bash
git add src/skills/hs-release-wf.md
git commit -m "feat(workflow): add hs-release-wf sample workflow skill"
```

---

### Summary

| Task | What | Files | Est. |
|------|------|-------|------|
| 1 | Type definitions | `src/workflow/types.ts`, `test/workflow/types.test.ts` | 3 min |
| 2 | Frontmatter parser | `src/workflow/parser.ts`, `test/workflow/parser.test.ts` | 5 min |
| 3 | DB schema migration | `src/db.ts` (append) | 2 min |
| 4 | Engine (core) | `src/workflow/engine.ts`, `test/workflow/engine.test.ts` | 10 min |
| 5 | Tools (run/resume) | `src/workflow/tools.ts`, `test/workflow/tools.test.ts` | 5 min |
| 6 | Server wiring | `src/server.ts` (~5 lines changed) | 2 min |
| 7 | Sample workflow | `src/skills/hs-release-wf.md` | 2 min |

**Existing files modified:** 2 (`src/db.ts`, `src/server.ts`)
**New files created:** 8 (4 source + 3 tests + 1 skill)
