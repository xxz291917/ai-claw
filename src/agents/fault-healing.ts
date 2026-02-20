import type { SubAgent, TaskExecution, AgentEvent } from "./types.js";
import type { FaultHealingWorkflow } from "../workflows/fault-healing.js";
import type { TaskStore } from "../tasks/store.js";

type FaultHealingAgentDeps = {
  workflow: FaultHealingWorkflow;
  store: TaskStore;
};

/**
 * SubAgent wrapper around FaultHealingWorkflow.
 *
 * Delegates to the existing workflow (zero rewrite risk) while conforming
 * to the SubAgent interface so it can be orchestrated by Core + Executor.
 *
 * Uses `task.skill` to differentiate entry points:
 * - "analysis" → workflow.runAnalysis(taskId)
 * - "action"   → workflow.handleAction(taskId, action)
 */
export class FaultHealingAgent implements SubAgent {
  readonly name = "fault-healing";
  readonly description = "Analyzes and fixes bugs from Sentry alerts";

  constructor(private deps: FaultHealingAgentDeps) {}

  async *execute(task: TaskExecution): AsyncIterable<AgentEvent> {
    const { workflow, store } = this.deps;
    const taskId = task.inputs.taskId as string;

    if (!taskId) {
      yield { type: "error", message: "Missing taskId in inputs" };
      return;
    }

    try {
      if (task.skill === "analysis") {
        yield { type: "thinking", content: `Analyzing Sentry issue for task ${taskId}` };
        await workflow.runAnalysis(taskId);
        const updated = store.getById(taskId);
        yield {
          type: "result",
          content: updated?.analysis ?? "Analysis complete",
          artifacts: updated?.analysis
            ? [{ kind: "analysis", data: { taskId, analysis: updated.analysis } }]
            : [],
        };
      } else if (task.skill === "action") {
        const action = task.inputs.action as string;
        if (!action) {
          yield { type: "error", message: "Missing action in inputs" };
          return;
        }
        yield { type: "thinking", content: `Handling action "${action}" for task ${taskId}` };
        await workflow.handleAction(taskId, action);
        const updated = store.getById(taskId);
        yield {
          type: "result",
          content: `Action "${action}" completed. Task state: ${updated?.state}`,
          artifacts: updated?.prUrl
            ? [{ kind: "pr", data: { url: updated.prUrl, taskId } }]
            : [],
        };
      } else {
        yield { type: "error", message: `Unknown skill: ${task.skill}` };
      }
    } catch (err: any) {
      yield { type: "error", message: err.message ?? String(err) };
    }
  }
}
