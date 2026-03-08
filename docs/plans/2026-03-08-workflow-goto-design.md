# Workflow Goto & Approval Action 设计

## 背景

当前 workflow 引擎是纯线性执行（steps 数组从头到尾），approval 步骤只有 approve/reject 两种操作。无法支持"用户反馈→修改→再审阅"的迭代循环场景。

## 目标

1. approval 步骤支持三种 action：`approve`、`revise`、`reject`
2. `revise` action 触发 goto 跳转，回到指定步骤重新执行
3. 可选 `max_revisions` 限制循环次数（默认不限制，不设置则可无限迭代）
4. 向后兼容：无 goto 的 approval 步骤行为不变

## 现状分析

### 当前架构

```
types.ts    → 类型定义（WorkflowStep, StepResult, WorkflowResult）
engine.ts   → 执行引擎（run, resume, executeSteps）
tools.ts    → UnifiedToolDef（run_workflow, resume_workflow, list_workflows）
parser.ts   → YAML frontmatter 解析
db.ts       → workflow_executions 表
```

### 当前 approval 流程

```
executeSteps() 遇到 approval → 暂停，返回 needs_approval
  ↓
resume(token, approve=true/false, userId, feedback?)
  ├─ approve=true  → 记录 StepResult(result=feedback||"approved")，继续 i+1
  └─ approve=false → 工作流失败
```

### 当前 resume 签名

```typescript
resume(token: string, approve: boolean, userId: string, feedback?: string)
```

## 设计方案

### 1. 类型变更（types.ts）

#### WorkflowStep — approval 扩展

```typescript
// 现在
| { id: string; approval: { prompt: string } }

// 改为
| { id: string; approval: {
    prompt: string;
    goto?: string;           // revise 时跳转目标步骤 id
    max_revisions?: number;  // 最大修订次数，不设置则不限制
  }}
```

#### StepResult — 增加 revision 字段

```typescript
export type StepResult = {
  id: string;
  ok: boolean;
  stdout?: string;
  result?: string;
  error?: string;
  file?: string;
  revision?: number;  // 当前是第几轮修订（仅 approval 步骤）
};
```

#### WorkflowResult — needs_approval 增加修订信息

```typescript
| {
    status: "needs_approval";
    prompt: string;
    token: string;
    completed_steps: StepResult[];
    revision?: number;       // 当前第几轮
    max_revisions?: number;  // 最大轮次
  }
```

### 2. resume 接口变更（engine.ts）

#### 新签名

```typescript
resume(
  token: string,
  action: "approve" | "revise" | "reject",
  userId: string,
  feedback?: string,
): Promise<WorkflowResult>
```

#### 三种 action 行为

| action | 条件 | 行为 |
|--------|------|------|
| `approve` | — | 记录 StepResult(result=feedback\|\|"approved")，继续执行 i+1 |
| `revise` | 需要 approval.goto | 记录 StepResult(result=feedback, revision=N)，跳转到 goto 目标步骤 |
| `revise` | 设置了 max_revisions 且 revision >= max | 自动失败："Maximum revisions reached" |
| `revise` | 无 approval.goto | 报错："This approval step does not support revision" |
| `reject` | — | 工作流失败，error=feedback\|\|"Rejected by user" |

### 3. executeSteps 变更（engine.ts）

#### goto 跳转逻辑

当 `resume(action="revise")` 被调用时：

```typescript
// 1. 找到 goto 目标步骤的 index
const gotoIdx = definition.steps.findIndex(s => s.id === approval.goto);

// 2. 清除从 gotoIdx 到当前 approvalIdx 的旧 StepResult
//    （这些步骤将被重新执行，旧结果不再有效）
const cleanedResults = results.filter(r => {
  const rIdx = definition.steps.findIndex(s => s.id === r.id);
  return rIdx < gotoIdx;  // 只保留 goto 之前的结果
});

// 3. 追加 approval 步骤的 revise 结果（保留 feedback）
cleanedResults.push({
  id: currentStepId,
  ok: true,
  result: feedback,
  revision: currentRevision,
});

// 4. 从 gotoIdx 开始重新执行
return this.executeSteps(execId, definition, args, gotoIdx, cleanedResults, ctx);
```

#### revision 计数

revision 次数通过 DB 中的 step_results 计算：

```typescript
// 统计同一个 approval 步骤出现了几次
const revisionCount = previousResults.filter(r => r.id === currentStepId).length;
```

不需要额外 DB 字段，从已有数据推导。

### 4. 变量引用（substituteVars）

循环中，同一个 step id 会产生多条 StepResult。`substituteVars` 取**最后一条**（最新结果）：

```typescript
// 现在
const stepResult = results.find((r) => r.id === stepId);

// 改为
const stepResult = results.findLast((r) => r.id === stepId);
```

新增 `${step.revision}` 变量：

```typescript
if (field === "revision") return String(stepResult.revision ?? 0);
```

### 5. tools.ts 变更

#### resume_workflow

```typescript
inputSchema: {
  token: z.string(),
  action: z.enum(["approve", "revise", "reject"]),
  feedback: z.string().optional(),
},
```

#### 向后兼容

旧的 `approve: boolean` 调用方式不再支持。由于 tool 定义直接面向 AI，改为 `action` enum 更清晰，AI 不会混淆。

### 6. parser.ts 变更

approval 块解析增加 `goto` 和 `max_revisions`：

```yaml
- id: review
  approval:
    prompt: "方案：${analyze.result}"
    goto: analyze
    max_revisions: 3
```

parser 的 `parseOneStep` 需要在 approval 块中额外解析这两个字段。

### 7. DB 变更

**无需变更**。`step_results` JSON 数组已经能存储多轮 StepResult（同一个 step id 出现多次）。`revision` 字段存在 StepResult JSON 中。

### 8. needs_approval 返回值增强

当 approval 步骤配置了 goto 时，返回额外信息帮助 AI 决策：

```typescript
return {
  status: "needs_approval",
  prompt,
  token: execId,
  completed_steps: results,
  // 新增：告知 AI 此步骤支持 revise
  revision: currentRevision,        // 当前第几轮（0 = 首次）
  max_revisions: approval.max_revisions,  // undefined = 不限制
};
```

AI 可以据此在提示中告诉用户"还剩 N 次修改机会"（如果有限制的话）。无 `max_revisions` 时 AI 不提示轮次限制。

## 完整流程示例

### bug 修复迭代

```yaml
# bug-fix-wf.md
workflow:
  args:
    issue:
      required: true
      description: Bug issue ID or description
  steps:
    - id: analyze
      type: llm
      prompt: |
        分析以下 bug 并给出修复方案：
        ${issue}
        上一轮反馈（如有）：${review.result}
    - id: review
      approval:
        prompt: "修复方案（第${review.revision}轮）：\n${analyze.result}\n\n请审阅，可选择批准、修改或拒绝。"
        goto: analyze
        max_revisions: 5
    - id: execute
      command: echo "执行修复方案..."
```

### 执行流程

```
run() → analyze(llm) → review(approval) → 暂停
  ↓
resume(action="revise", feedback="改用方案B")
  → 记录 review.result="改用方案B", review.revision=1
  → 清除 analyze 旧结果
  → 跳回 analyze（llm 读到 ${review.result}="改用方案B"）
  → review(approval) → 暂停（revision=1, max=5）
  ↓
resume(action="revise", feedback="还需考虑并发问题")
  → review.revision=2, 跳回 analyze
  → ...
  ↓
resume(action="approve")
  → 继续 execute 步骤
  → 工作流完成
```

## 影响范围

| 文件 | 变更 |
|------|------|
| `src/workflow/types.ts` | approval 类型扩展，StepResult 加 revision，WorkflowResult 加 revision/max |
| `src/workflow/engine.ts` | resume() 改 action enum，goto 跳转逻辑，revision 计数，substituteVars 用 findLast |
| `src/workflow/tools.ts` | resume_workflow 改 action enum，去掉 approve boolean |
| `src/workflow/parser.ts` | 解析 approval.goto 和 approval.max_revisions |
| `test/workflow/engine.test.ts` | 新增 goto 循环测试，更新现有 resume 测试用 action |
| `test/workflow/tools.test.ts` | 更新 resume_workflow 参数 |
| `test/workflow/parser.test.ts` | 新增 goto/max_revisions 解析测试 |
| `src/skills/demo-wf.md` | 更新为使用 goto 的迭代演示 |

## 测试用例

1. **基本 goto 循环**：revise → 跳回目标步骤 → 再次到达 approval
2. **max_revisions 限制**：设置上限后超过自动 reject；不设置则可无限迭代
3. **approve 跳出循环**：revise 若干次后 approve，继续后续步骤
4. **reject 终止**：循环中 reject 直接失败
5. **无 goto 的 approval**：revise 报错，approve/reject 正常（向后兼容）
6. **变量引用取最新**：`${step.result}` 取最后一轮的结果
7. **revision 计数正确**：从 step_results 中推导
8. **结果清理**：goto 跳转时清除中间步骤的旧结果
