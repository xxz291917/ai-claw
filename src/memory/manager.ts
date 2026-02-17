import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { MemoryItem, ExtractedMemory } from "./types.js";

export class MemoryManager {
  constructor(private db: Database.Database) {}

  save(
    userId: string,
    items: ExtractedMemory[],
    sourceSessionId?: string,
  ): void {
    const upsert = this.db.prepare(`
      INSERT INTO memory (id, user_id, category, key, value, source_session_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, category, key) DO UPDATE SET
        value = excluded.value,
        source_session_id = excluded.source_session_id,
        updated_at = datetime('now')
    `);

    const run = this.db.transaction((rows: ExtractedMemory[]) => {
      for (const item of rows) {
        upsert.run(
          randomUUID(),
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
