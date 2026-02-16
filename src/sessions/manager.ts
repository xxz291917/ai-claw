import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Session, Message } from "./types.js";

type CreateSessionParams = {
  userId: string;
  channel: string;
  channelId: string;
  provider: string;
};

type AppendMessageParams = {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: string;
};

export class SessionManager {
  constructor(private db: Database.Database) {}

  create(params: CreateSessionParams): Session {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, channel, channel_id, provider)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, params.userId, params.channel, params.channelId, params.provider);

    return this.getById(id)!;
  }

  getById(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as any;
    return row ? this.mapSessionRow(row) : null;
  }

  findActive(userId: string, channel: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE user_id = ? AND channel = ? AND status = 'active'
         ORDER BY last_active_at DESC LIMIT 1`,
      )
      .get(userId, channel) as any;
    return row ? this.mapSessionRow(row) : null;
  }

  updateProviderSessionId(id: string, providerSessionId: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET provider_session_id = ? WHERE id = ?",
      )
      .run(providerSessionId, id);
  }

  touch(id: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?",
      )
      .run(id);
  }

  close(id: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET status = 'closed', last_active_at = datetime('now') WHERE id = ?",
      )
      .run(id);
  }

  appendMessage(sessionId: string, params: AppendMessageParams): Message {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, tool_calls)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, params.role, params.content, params.toolCalls ?? null);

    this.touch(sessionId);

    return this.getMessageById(id)!;
  }

  clearMessages(sessionId: string): void {
    this.db
      .prepare("DELETE FROM messages WHERE session_id = ?")
      .run(sessionId);
  }

  countMessages(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?")
      .get(sessionId) as any;
    return row?.count ?? 0;
  }

  getMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as any[];
    return rows.map((row) => this.mapMessageRow(row));
  }

  private getMessageById(id: string): Message | null {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(id) as any;
    return row ? this.mapMessageRow(row) : null;
  }

  private mapSessionRow(row: any): Session {
    return {
      id: row.id,
      userId: row.user_id,
      channel: row.channel,
      channelId: row.channel_id,
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      status: row.status,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  private mapMessageRow(row: any): Message {
    return {
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      toolCalls: row.tool_calls,
      createdAt: row.created_at,
    };
  }
}
