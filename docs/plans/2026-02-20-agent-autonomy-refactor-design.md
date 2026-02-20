# Agent Autonomy Refactor Design

> Date: 2026-02-20

## Background

The current Fault Healing pipeline uses a heavyweight orchestration layer (EventBus → Core → RuleRouter → Executor → SubAgent) with a 9-state state machine, two-phase workflow, and Lark approval callbacks. This infrastructure serves only one consumer (Fault Healing) and adds significant complexity.

## Goal

Refactor to Agent Autonomy mode: let the LLM agent handle the entire fault-healing flow autonomously using tools and skills, eliminating the orchestration layer. Keep the system clean and intelligent.

## Design

### What Changes

**Delete (orchestration layer):**
- `src/core/core.ts` — orchestration engine
- `src/core/executor.ts` — plan executor
- `src/core/rule-router.ts` — rule-based event routing
- `src/agents/registry.ts` — agent registry
- `src/agents/types.ts` — SubAgent interface
- `src/agents/fault-healing.ts` — SubAgent wrapper
- `src/routes/fault-healing.ts` — event route definitions
- `src/workflows/fault-healing.ts` — two-phase workflow
- `src/tasks/types.ts` — 9-state state machine
- `src/tasks/store.ts` — TaskStore with state transitions
- `src/lark/callback.ts` — Lark approval callback handler
- `src/adapters/` — all input/output adapters
- `test/agents/fault-healing.test.ts`

**Modify:**
- `src/core/event-bus.ts` → downgrade to EventLog (remove `on`/`matches`, rename `emit` to `log`)
- `src/webhooks/sentry.ts` → simplify: dedup + record task + call agent runner directly
- `src/routes/webhooks.ts` → remove Lark callback route, simplify Sentry route
- `src/lark/notify.ts` → notification-only cards (remove approval buttons)
- `src/server.ts` — remove Core/RuleRouter/Executor/Registry/Adapter initialization

**Keep as-is:**
- `src/core/hub-event.ts` — unified event type (useful for audit logging)
- `src/agent/runner.ts` — Agent Runner
- `src/chat/` — all chat-related files
- `src/tools/` — all tools
- `src/skills/` — all skills (fault-healing.md to be enhanced)
- `src/sessions/`, `src/memory/` — session and memory management

### New Flow

```
Sentry webhook → dedup → record task (minimal) → Agent Runner (fire-and-forget)
                                                      │
                                                Agent autonomously:
                                                  1. sentry_query → error details
                                                  2. file_read → source code
                                                  3. bash → create branch, fix, test
                                                  4. bash → gh pr create
                                                  5. lark_notify → notification card
                                                      │
                                                Update task record (done/failed)
```

### Task Record (minimal)

Replace TaskStore + state machine with a simple record:

```typescript
type TaskRecord = {
  id: string;
  sentryIssueId: string;
  title: string;
  status: "running" | "done" | "failed";
  prUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
```

No state machine, no transition validation. Just a log of what happened.

### Human Review

Moves from Lark card approval buttons to GitHub PR review — the standard code review flow. Lark cards become informational notifications (issue detected, PR created).

### EventLog

EventBus stripped to audit-only:

```typescript
export class EventLog {
  constructor(private db: Database.Database) {}

  log(event: HubEvent): void {
    this.db.prepare("INSERT INTO event_log ...").run(...);
  }
}
```

## Trade-offs

- **Lost**: mid-flow recovery (can re-run instead), Lark-based approval (use PR review)
- **Gained**: ~10 fewer files, ~500 fewer lines, much simpler server initialization, single clear flow
