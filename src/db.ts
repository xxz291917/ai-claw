import Database from "better-sqlite3";

export function initDb(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'fault_healing',
      state TEXT NOT NULL DEFAULT 'pending',
      sentry_issue_id TEXT,
      sentry_event_id TEXT,
      title TEXT NOT NULL,
      severity TEXT,
      analysis TEXT,
      pr_url TEXT,
      lark_message_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_sentry_issue
      ON tasks(sentry_issue_id);

    CREATE INDEX IF NOT EXISTS idx_tasks_state
      ON tasks(state);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function createDb(path: string): Database.Database {
  const db = new Database(path);
  initDb(db);
  return db;
}
