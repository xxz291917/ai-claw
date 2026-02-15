import type { RuleRouter } from "./rule-router.js";
import type { Executor } from "./executor.js";
import type { SessionManager } from "../sessions/manager.js";
import type { HubEvent } from "./hub-event.js";

type CoreDeps = {
  ruleRouter: RuleRouter;
  executor: Executor;
  sessionManager: SessionManager;
  handleChat: (event: HubEvent) => Promise<void> | void;
};

export class Core {
  constructor(private deps: CoreDeps) {}

  async handle(event: HubEvent): Promise<void> {
    // 1. Chat events -> session-based chat flow
    if (event.type.startsWith("chat.")) {
      return this.deps.handleChat(event);
    }

    // 2. Rule-based routing
    const plan = this.deps.ruleRouter.match(event);
    if (plan) {
      return this.deps.executor.run(plan, event);
    }

    // 3. Unmatched events — log and skip for now
    // TODO: OrchestratorAgent for AI-based decision
    console.warn(`[core] No handler for event: ${event.type}`);
  }
}
