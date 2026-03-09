/**
 * SQLite-backed CRUD for cron jobs.
 * Uses the project's shared SQLite database (WAL mode).
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { CronJob, CronJobInput, CronJobPatch, CronRunStatus } from "./types.js";
import { computeNextRunAt } from "./schedule.js";

// ---------------------------------------------------------------------------
// Schema initialisation (called from db.ts)
// ---------------------------------------------------------------------------

export function initCronSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      enabled            INTEGER NOT NULL DEFAULT 1,
      schedule           TEXT NOT NULL,
      payload            TEXT NOT NULL,
      user_id            TEXT NOT NULL,
      delete_after_run   INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      next_run_at        INTEGER,
      last_run_at        INTEGER,
      last_status        TEXT,
      last_error         TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_cron_next_run
      ON cron_jobs(next_run_at) WHERE enabled = 1;

    CREATE INDEX IF NOT EXISTS idx_cron_user
      ON cron_jobs(user_id);
  `);
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToJob(row: any): CronJob {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    schedule: JSON.parse(row.schedule),
    payload: JSON.parse(row.payload),
    userId: row.user_id,
    deleteAfterRun: row.delete_after_run === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at ?? null,
    lastRunAt: row.last_run_at ?? null,
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    consecutiveErrors: row.consecutive_errors,
  };
}

// ---------------------------------------------------------------------------
// CronStore
// ---------------------------------------------------------------------------

export class CronStore {
  private stmts: ReturnType<typeof prepareStatements>;

  constructor(private db: Database.Database) {
    this.stmts = prepareStatements(db);
  }

  add(input: CronJobInput): CronJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    const nextRunAt = computeNextRunAt(input.schedule, Date.now());

    this.stmts.insert.run({
      id,
      name: input.name,
      enabled: (input.enabled ?? true) ? 1 : 0,
      schedule: JSON.stringify(input.schedule),
      payload: JSON.stringify(input.payload),
      user_id: input.userId,
      delete_after_run: (input.deleteAfterRun ?? false) ? 1 : 0,
      created_at: now,
      updated_at: now,
      next_run_at: nextRunAt,
    });

    return this.getById(id)!;
  }

  getById(id: string): CronJob | null {
    const row = this.stmts.getById.get(id);
    return row ? rowToJob(row) : null;
  }

  list(): CronJob[] {
    return this.stmts.listAll.all().map(rowToJob);
  }

  listByUser(userId: string): CronJob[] {
    return this.stmts.listByUser.all(userId).map(rowToJob);
  }

  listDue(nowMs: number): CronJob[] {
    return this.stmts.listDue.all(nowMs).map(rowToJob);
  }

  update(id: string, patch: CronJobPatch): CronJob | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const schedule = patch.schedule ?? existing.schedule;
    const enabled = patch.enabled ?? existing.enabled;
    const nextRunAt = enabled
      ? computeNextRunAt(schedule, Date.now())
      : existing.nextRunAt;

    this.stmts.update.run({
      id,
      name: patch.name ?? existing.name,
      enabled: enabled ? 1 : 0,
      schedule: JSON.stringify(schedule),
      payload: JSON.stringify(patch.payload ?? existing.payload),
      delete_after_run: (patch.deleteAfterRun ?? existing.deleteAfterRun) ? 1 : 0,
      updated_at: new Date().toISOString(),
      next_run_at: nextRunAt,
    });

    return this.getById(id);
  }

  remove(id: string): boolean {
    return this.stmts.remove.run(id).changes > 0;
  }

  /** Mark a job as started (set lastRunAt, clear nextRunAt to prevent double-fire) */
  markStarted(id: string, nowMs: number): void {
    this.stmts.markStarted.run(nowMs, id);
  }

  /** Mark a job as finished and compute next run */
  markFinished(id: string, status: CronRunStatus, error?: string): void {
    const job = this.getById(id);
    if (!job) return;

    const consecutive = status === "error"
      ? job.consecutiveErrors + 1
      : 0;

    const nextRunAt = job.enabled
      ? computeNextRunAt(job.schedule, Date.now())
      : null;

    this.stmts.markFinished.run({
      id,
      last_status: status,
      last_error: error ?? null,
      consecutive_errors: consecutive,
      next_run_at: nextRunAt,
      updated_at: new Date().toISOString(),
    });
  }

  /** Get the earliest next_run_at across all enabled jobs */
  nextWakeAt(): number | null {
    const row = this.stmts.nextWake.get() as { min_next: number | null } | undefined;
    return row?.min_next ?? null;
  }
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

function prepareStatements(db: Database.Database) {
  return {
    insert: db.prepare(`
      INSERT INTO cron_jobs (id, name, enabled, schedule, payload, user_id, delete_after_run, created_at, updated_at, next_run_at)
      VALUES (@id, @name, @enabled, @schedule, @payload, @user_id, @delete_after_run, @created_at, @updated_at, @next_run_at)
    `),

    getById: db.prepare(`SELECT * FROM cron_jobs WHERE id = ?`),

    listAll: db.prepare(`SELECT * FROM cron_jobs ORDER BY created_at`),

    listByUser: db.prepare(`SELECT * FROM cron_jobs WHERE user_id = ? ORDER BY created_at`),

    listDue: db.prepare(`
      SELECT * FROM cron_jobs
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at
    `),

    update: db.prepare(`
      UPDATE cron_jobs
      SET name = @name, enabled = @enabled, schedule = @schedule, payload = @payload,
          delete_after_run = @delete_after_run, updated_at = @updated_at, next_run_at = @next_run_at
      WHERE id = @id
    `),

    remove: db.prepare(`DELETE FROM cron_jobs WHERE id = ?`),

    markStarted: db.prepare(`
      UPDATE cron_jobs SET last_run_at = ?, next_run_at = NULL WHERE id = ?
    `),

    markFinished: db.prepare(`
      UPDATE cron_jobs
      SET last_status = @last_status, last_error = @last_error,
          consecutive_errors = @consecutive_errors, next_run_at = @next_run_at,
          updated_at = @updated_at
      WHERE id = @id
    `),

    nextWake: db.prepare(`
      SELECT MIN(next_run_at) as min_next FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL
    `),
  };
}
