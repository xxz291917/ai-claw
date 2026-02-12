import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  transitions,
  type Task,
  type TaskEvent,
  type TaskState,
} from "./types.js";

type CreateParams = {
  sentryIssueId: string;
  sentryEventId: string;
  title: string;
  severity: string;
};

export class TaskStore {
  constructor(private db: Database.Database) {}

  create(params: CreateParams): Task {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks (id, sentry_issue_id, sentry_event_id, title, severity)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.sentryIssueId,
        params.sentryEventId,
        params.title,
        params.severity,
      );

    return this.getById(id)!;
  }

  getById(id: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  findByIssueId(issueId: string): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE sentry_issue_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(issueId) as any;
    return row ? this.mapRow(row) : null;
  }

  transition(id: string, event: TaskEvent): Task {
    const task = this.getById(id);
    if (!task) throw new Error(`Task not found: ${id}`);

    const rule = transitions[event];
    if (!rule.from.includes(task.state)) {
      throw new Error(
        `Invalid transition: cannot apply "${event}" to task in state "${task.state}"`,
      );
    }

    this.db
      .prepare(
        "UPDATE tasks SET state = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(rule.to, id);

    this.audit(id, event, `${task.state} → ${rule.to}`);

    return this.getById(id)!;
  }

  updateAnalysis(id: string, analysis: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET analysis = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(analysis, id);
  }

  updatePrUrl(id: string, prUrl: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET pr_url = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(prUrl, id);
  }

  updateLarkMessageId(id: string, messageId: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET lark_message_id = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(messageId, id);
  }

  updateError(id: string, error: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET error = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(error, id);
  }

  private audit(taskId: string, action: string, detail: string): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (task_id, action, detail) VALUES (?, ?, ?)",
      )
      .run(taskId, action, detail);
  }

  private mapRow(row: any): Task {
    return {
      id: row.id,
      type: row.type,
      state: row.state as TaskState,
      sentryIssueId: row.sentry_issue_id,
      sentryEventId: row.sentry_event_id,
      title: row.title,
      severity: row.severity,
      analysis: row.analysis,
      prUrl: row.pr_url,
      larkMessageId: row.lark_message_id,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
