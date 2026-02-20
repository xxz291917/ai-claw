import type Database from "better-sqlite3";
import type { AgentRegistry } from "../agents/registry.js";
import type { TaskPlan } from "./rule-router.js";
import type { HubEvent } from "./hub-event.js";
import type { OutputAction } from "../adapters/output/types.js";
import type { AgentEvent } from "../agents/types.js";

type ExecutorDeps = {
  registry: AgentRegistry;
  db: Database.Database;
  outputSend: (action: OutputAction, agentEvent: AgentEvent) => Promise<void> | void;
};

export class Executor {
  constructor(private deps: ExecutorDeps) {}

  async run(plan: TaskPlan, event: HubEvent): Promise<void> {
    const agent = this.deps.registry.get(plan.agent);
    if (!agent) throw new Error(`Agent not found: ${plan.agent}`);

    // Use plan-provided taskId when available (e.g. fault healing creates the
    // task before emitting the event). Falls back to event.id for other flows.
    const taskId = (plan.inputs.taskId as string) || event.id;

    const execution = {
      taskId,
      skill: plan.skill,
      inputs: plan.inputs,
      provider: plan.provider ?? "claude",
    };

    for await (const agentEvent of agent.execute(execution)) {
      // Log to audit_log
      this.logEvent(taskId, agentEvent);

      // On result -> trigger outputs
      if (agentEvent.type === "result") {
        for (const output of plan.outputs) {
          await this.deps.outputSend(output, agentEvent);
        }
      }
    }
  }

  private logEvent(taskId: string, agentEvent: AgentEvent): void {
    try {
      this.deps.db
        .prepare("INSERT INTO audit_log (task_id, action, detail) VALUES (?, ?, ?)")
        .run(taskId, agentEvent.type, JSON.stringify(agentEvent));
    } catch {
      // audit_log has FK constraint on tasks(id); skip logging if task row missing
    }
  }
}
