import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Session, Message, MessageType } from "./types.js";

type CreateSessionParams = {
  userId: string;
  channel: string;
  channelId: string;
  provider: string;
};

type AppendMessageParams = {
  role: "user" | "assistant" | "system";
  content: string;
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
    const result = this.db
      .prepare(
        `INSERT INTO messages (session_id, role, content)
         VALUES (?, ?, ?)`,
      )
      .run(sessionId, params.role, params.content);

    this.touch(sessionId);

    return this.getMessageById(Number(result.lastInsertRowid))!;
  }

  clearMessages(sessionId: string): void {
    this.db
      .prepare("DELETE FROM messages WHERE session_id = ?")
      .run(sessionId);
  }

  /**
   * Replace all messages for a session with a new set.
   * Used by /reset commands. For compaction, prefer compactMessages().
   */
  replaceMessages(
    sessionId: string,
    messages: Array<{ role: "user" | "assistant" | "system"; content: string; type?: MessageType }>,
  ): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM messages WHERE session_id = ?")
        .run(sessionId);

      const insert = this.db.prepare(
        `INSERT INTO messages (session_id, role, content, type) VALUES (?, ?, ?, ?)`,
      );
      for (const m of messages) {
        insert.run(sessionId, m.role, m.content, m.type ?? "message");
      }
    });
    txn();
  }

  /**
   * Incremental compaction: delete only the early messages and insert a summary.
   * Recent messages keep their original IDs and timestamps.
   *
   * Strategy: reuse the lowest deleted ID for the summary message so that
   * `ORDER BY id ASC` still produces the correct chronological order.
   */
  compactMessages(
    sessionId: string,
    keepCount: number,
    summary: { role: "user" | "assistant" | "system"; content: string; type?: MessageType },
  ): void {
    const txn = this.db.transaction(() => {
      const allRows = this.db
        .prepare("SELECT id, created_at FROM messages WHERE session_id = ? ORDER BY id ASC")
        .all(sessionId) as Array<{ id: number; created_at: string }>;

      const total = allRows.length;
      const cutoff = total - keepCount;
      if (cutoff <= 0) return;

      const earlyRows = allRows.slice(0, cutoff);
      const lastEarly = earlyRows[earlyRows.length - 1];
      const summaryId = lastEarly.id;
      const summaryTimestamp = lastEarly.created_at;

      // Delete early messages
      const placeholders = earlyRows.map(() => "?").join(",");
      this.db
        .prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
        .run(...earlyRows.map((r) => r.id));

      // Insert summary at the position of the first deleted message
      this.db
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, type, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          summaryId,
          sessionId,
          summary.role,
          summary.content,
          summary.type ?? "summary",
          summaryTimestamp,
        );
    });
    txn();
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
        "SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC",
      )
      .all(sessionId) as any[];
    return rows.map((row) => this.mapMessageRow(row));
  }

  private getMessageById(id: number): Message | null {
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
      type: row.type ?? "message",
      createdAt: row.created_at,
    };
  }
}
