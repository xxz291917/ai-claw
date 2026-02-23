import type Database from "better-sqlite3";
import type { MemoryItem, ExtractedMemory } from "./types.js";

export class MemoryManager {
  constructor(private db: Database.Database) {}

  save(
    userId: string,
    items: ExtractedMemory[],
    sourceSessionId?: string,
  ): void {
    const upsert = this.db.prepare(`
      INSERT INTO memory (user_id, category, key, value, source_session_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, category, key) DO UPDATE SET
        value = excluded.value,
        source_session_id = excluded.source_session_id,
        updated_at = datetime('now')
    `);

    const run = this.db.transaction((rows: ExtractedMemory[]) => {
      for (const item of rows) {
        upsert.run(
          userId,
          item.category,
          item.key,
          item.value,
          sourceSessionId ?? null,
        );
      }
    });

    run(items);
  }

  getByUser(userId: string): MemoryItem[] {
    const rows = this.db
      .prepare("SELECT * FROM memory WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId) as any[];
    return rows.map(mapRow);
  }

  search(userId: string, query: string, limit = 5): MemoryItem[] {
    // Convert query terms to prefix matches for CJK compatibility.
    // FTS5 unicode61 tokenizer groups consecutive CJK characters into a
    // single token, so "部署" won't match the token "部署方案" without a
    // prefix wildcard.  We split on whitespace, append '*' to each term,
    // and join with OR so any matching term surfaces results.
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(" OR ");

    if (!ftsQuery) return [];

    const rows = this.db
      .prepare(
        `SELECT m.* FROM memory m
         JOIN memory_fts fts ON m.id = fts.rowid
         WHERE fts.memory_fts MATCH ? AND m.user_id = ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(ftsQuery, userId, limit) as any[];
    return rows.map(mapRow);
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM memory WHERE id = ?").run(id);
  }

  /** Delete a memory only if it belongs to the given user. Returns true if deleted. */
  removeByUser(id: number, userId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM memory WHERE id = ? AND user_id = ?")
      .run(id, userId);
    return result.changes > 0;
  }
}

function mapRow(row: any): MemoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category,
    key: row.key,
    value: row.value,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
