import type { TaskStore } from "../tasks/store.js";
import {
  buildDiagnosisCard,
  buildPrReadyCard,
} from "../lark/notify.js";

type AgentResult = {
  text: string;
  sessionId: string;
  costUsd: number;
  error?: string;
};

type WorkflowDeps = {
  store: TaskStore;
  runAgent: (prompt: string) => Promise<AgentResult>;
  sendLarkCard: (card: any) => Promise<string | null>;
};

export class FaultHealingWorkflow {
  constructor(private deps: WorkflowDeps) {}

  /**
   * Phase 1: Analysis
   * pending → analyzing → reported (or failed)
   */
  async runAnalysis(taskId: string): Promise<void> {
    const { store, runAgent, sendLarkCard } = this.deps;

    const task = store.getById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Transition to analyzing
    store.transition(taskId, "analyze");

    const prompt = `Analyze Sentry issue #${task.sentryIssueId}.

Use the sentry_query tool with issue_id "${task.sentryIssueId}" to get the error details.

Then read the relevant source code files and determine the root cause.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "rootCause": "brief description of the root cause",
  "confidence": "percentage like 85%",
  "impact": "affected users / frequency",
  "affectedFiles": ["file1.ts", "file2.ts"],
  "suggestedFix": "brief description of the fix",
  "complexity": "low|medium|high"
}`;

    const result = await runAgent(prompt);

    if (result.error || !result.text) {
      store.updateError(taskId, result.error ?? "Empty analysis result");
      store.transition(taskId, "fail");
      return;
    }

    // Store raw analysis
    store.updateAnalysis(taskId, result.text);

    // Parse analysis for Lark card
    let parsed: any;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      // If AI didn't return clean JSON, use raw text
      parsed = {
        rootCause: result.text.slice(0, 200),
        confidence: "unknown",
        impact: "unknown",
      };
    }

    // Transition to reported
    store.transition(taskId, "report");

    // Send Lark diagnosis card
    const card = buildDiagnosisCard({
      taskId,
      title: task.title,
      severity: task.severity ?? "P3",
      rootCause: parsed.rootCause ?? "See analysis",
      confidence: parsed.confidence ?? "unknown",
      impact: parsed.impact ?? "unknown",
    });

    const messageId = await sendLarkCard(card);
    if (messageId) {
      store.updateLarkMessageId(taskId, messageId);
    }
  }

  /**
   * Phase 2: Fix
   * reported → fixing → pr_ready (or failed)
   */
  async runFix(taskId: string): Promise<void> {
    const { store, runAgent, sendLarkCard } = this.deps;

    const task = store.getById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Transition to fixing
    store.transition(taskId, "fix");

    const prompt = `Fix Sentry issue #${task.sentryIssueId}.

Previous analysis:
${task.analysis}

Steps:
1. Create branch: fix/sentry-${task.sentryIssueId}
2. Make the minimal code fix based on the analysis
3. Add a regression test
4. Run the test suite
5. If tests pass, create a PR with: gh pr create --title "fix: ${task.title} (sentry #${task.sentryIssueId})" --body "..."

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "prUrl": "the PR URL",
  "prNumber": 42,
  "filesChanged": 2,
  "linesAdded": 10,
  "testsPassed": 15,
  "testsFailed": 0
}

If you cannot fix it or tests fail, respond with:
{
  "error": "description of what went wrong"
}`;

    const result = await runAgent(prompt);

    if (result.error || !result.text) {
      store.updateError(taskId, result.error ?? "Empty fix result");
      store.transition(taskId, "fail");
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      store.updateError(taskId, "AI returned non-JSON response");
      store.transition(taskId, "fail");
      return;
    }

    if (parsed.error) {
      store.updateError(taskId, parsed.error);
      store.transition(taskId, "fail");
      return;
    }

    // Store PR URL and transition
    store.updatePrUrl(taskId, parsed.prUrl);
    store.transition(taskId, "pr_created");

    // Send Lark PR ready card
    const card = buildPrReadyCard({
      taskId,
      prUrl: parsed.prUrl,
      prNumber: parsed.prNumber ?? 0,
      filesChanged: parsed.filesChanged ?? 0,
      linesAdded: parsed.linesAdded ?? 0,
      testsPassed: parsed.testsPassed ?? 0,
      testsFailed: parsed.testsFailed ?? 0,
    });

    const messageId = await sendLarkCard(card);
    if (messageId) {
      store.updateLarkMessageId(taskId, messageId);
    }
  }

  /**
   * Handle approval callback from Lark.
   */
  async handleAction(taskId: string, action: string): Promise<void> {
    const { store } = this.deps;

    switch (action) {
      case "fix":
        await this.runFix(taskId);
        break;
      case "merge":
        store.transition(taskId, "merge");
        // TODO: trigger actual PR merge via gh CLI
        break;
      case "ignore":
        store.transition(taskId, "ignore");
        break;
      case "reject":
        store.transition(taskId, "reject");
        break;
      default:
        console.warn(`Unknown action: ${action}`);
    }
  }
}
