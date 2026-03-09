import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { initCronSchema } from "./cron/store.js";

export function initDb(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      sentry_issue_id TEXT,
      title TEXT NOT NULL,
      severity TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      pr_url TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_sentry_issue
      ON tasks(sentry_issue_id);

    CREATE INDEX IF NOT EXISTS idx_tasks_status
      ON tasks(status);

    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      payload TEXT NOT NULL,
      context TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_event_log_type
      ON event_log(type, created_at);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      provider_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user
      ON sessions(user_id, status);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'message',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_upsert
      ON memory(user_id, category, key);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      key, value,
      content=memory, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
      INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
    END;

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY,
      custom_prompt TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      args TEXT NOT NULL DEFAULT '{}',
      current_step TEXT,
      step_results TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_executions_session
      ON workflow_executions(session_id, status);
  `);

  // Cron jobs table (separate function to keep schema modular)
  initCronSchema(db);
}

export function createDb(path: string): Database.Database {
  // Ensure directory exists
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const db = new Database(path);
  initDb(db);
  return db;
}
