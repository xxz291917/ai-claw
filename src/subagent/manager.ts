import { randomUUID } from "node:crypto";
import type { ProviderRegistry } from "../chat/provider-registry.js";
import type { SessionManager } from "../sessions/manager.js";
import {
  handleConversation,
  type ConversationDeps,
} from "../chat/conversation.js";
import type { EventLog } from "../core/event-bus.js";

export type SubagentTask = {
  id: string;
  task: string;
  parentSessionId: string;
  userId: string;
  providerName: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  createdAt: number;
  completedAt?: number;
};

export type SpawnOpts = {
  task: string;
  parentSessionId: string;
  userId: string;
  providerName: string;
};

export type SubagentManagerConfig = {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
};

export class SubagentManager {
  private tasks = new Map<string, SubagentTask>();
  private abortControllers = new Map<string, AbortController>();

  constructor(private config: SubagentManagerConfig) {}

  spawn(opts: SpawnOpts): string {
    const id = randomUUID();
    const task: SubagentTask = {
      id,
      task: opts.task,
      parentSessionId: opts.parentSessionId,
      userId: opts.userId,
      providerName: opts.providerName,
      status: "running",
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);

    const controller = new AbortController();
    this.abortControllers.set(id, controller);

    this.run(task, controller.signal).catch((err) => {
      if (task.status === "running") {
        task.status = "failed";
        task.error = err.message ?? String(err);
        task.completedAt = Date.now();
      }
    });

    return id;
  }

  private async run(task: SubagentTask, signal: AbortSignal): Promise<void> {
    const { registry, sessionManager } = this.config;

    const provider = registry.create(task.providerName, { mode: "minimal" });

    // Minimal deps — no memoryManager for subagents
    const deps: ConversationDeps = {
      provider,
      sessionManager,
      eventLog: { log: () => {} } as unknown as EventLog,
    };

    const result = await handleConversation({
      userId: task.userId,
      message: task.task,
      channel: "subagent",
      channelId: task.id,
      deps,
      abortSignal: signal,
      skipConfirmation: true, // subagents run autonomously — no human in the loop
    });

    if (task.status !== "running") return; // was cancelled

    task.status = "completed";
    task.result = result.text;
    task.completedAt = Date.now();

    // Write result to parent session
    sessionManager.appendMessage(task.parentSessionId, {
      role: "system",
      content: `[后台任务完成] ${task.task}\n\n结果: ${result.text}`,
    });
  }

  getTask(id: string): SubagentTask | undefined {
    return this.tasks.get(id);
  }

  listBySession(sessionId: string): SubagentTask[] {
    return [...this.tasks.values()].filter(
      (t) => t.parentSessionId === sessionId,
    );
  }

  cancelBySession(sessionId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.parentSessionId === sessionId && task.status === "running") {
        task.status = "cancelled";
        task.completedAt = Date.now();
        this.abortControllers.get(task.id)?.abort();
        count++;
      }
    }
    return count;
  }
}
