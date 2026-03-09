/**
 * CronService — lightweight scheduler with timer-based execution.
 *
 * Core algorithm (inspired by OpenClaw):
 * 1. Load all enabled jobs, compute nextRunAt
 * 2. Arm a timer at the earliest nextRunAt (capped at MAX_TIMER_DELAY)
 * 3. On timer fire: find due jobs → execute → update state → re-arm
 *
 * Reliability:
 * - Exponential backoff on consecutive errors
 * - MAX_TIMER_DELAY prevents timer drift from long sleeps
 * - MIN_REFIRE_GAP prevents runaway re-execution
 * - Concurrent execution capped at MAX_CONCURRENT
 */

import type Database from "better-sqlite3";
import type { ProviderRegistry } from "../chat/provider-registry.js";
import type { SessionManager } from "../sessions/manager.js";
import type { EventLog } from "../core/event-bus.js";
import type { MemoryManager } from "../memory/manager.js";
import { handleConversation } from "../chat/conversation.js";
import { CronStore } from "./store.js";
import { computeNextRunAt, describeSchedule } from "./schedule.js";
import type { CronJob, CronJobInput, CronJobPatch, CronEvent, CronRunStatus } from "./types.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants (same philosophy as OpenClaw)
// ---------------------------------------------------------------------------

/** Max timer delay — prevents drift from long idle periods */
const MAX_TIMER_DELAY_MS = 60_000;

/** Min gap between ticks — prevents runaway execution */
const MIN_REFIRE_GAP_MS = 2_000;

/** Max concurrent job executions */
const MAX_CONCURRENT = 3;

/** Backoff schedule for consecutive errors */
const BACKOFF_MS = [
  30_000,       // 1st error  →  30s
  60_000,       // 2nd error  →   1m
  5 * 60_000,   // 3rd error  →   5m
  15 * 60_000,  // 4th error  →  15m
  60 * 60_000,  // 5th+ error →  60m
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type CronServiceConfig = {
  db: Database.Database;
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  eventLog: EventLog;
  memoryManager?: MemoryManager;
  defaultProvider: string;
  maxHistoryTokens?: number;
  /** Called for every cron lifecycle event (start/finish/add/remove) */
  onEvent?: (event: CronEvent) => void;
};

// ---------------------------------------------------------------------------
// CronService
// ---------------------------------------------------------------------------

export class CronService {
  private store: CronStore;
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  private lastTickMs = 0;
  private started = false;

  constructor(private config: CronServiceConfig) {
    this.store = new CronStore(config.db);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;

    // Recompute nextRunAt for all enabled jobs on startup
    for (const job of this.store.list()) {
      if (job.enabled && job.nextRunAt == null) {
        const next = computeNextRunAt(job.schedule, Date.now());
        if (next) {
          this.store.markFinished(job.id, job.lastStatus ?? "ok");
        }
      }
    }

    const count = this.store.list().filter((j) => j.enabled).length;
    log.info(`[cron] Started (${count} enabled jobs)`);
    this.armTimer();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info("[cron] Stopped");
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  add(input: CronJobInput): CronJob {
    const job = this.store.add(input);
    log.info(`[cron] Added job "${job.name}" (${job.id}) — ${describeSchedule(job.schedule)}`);
    this.emit({ type: "added", jobId: job.id, jobName: job.name });
    this.armTimer();
    return job;
  }

  update(id: string, patch: CronJobPatch): CronJob | null {
    const job = this.store.update(id, patch);
    if (job) {
      log.info(`[cron] Updated job "${job.name}" (${job.id})`);
      this.armTimer();
    }
    return job;
  }

  remove(id: string): boolean {
    const job = this.store.getById(id);
    const ok = this.store.remove(id);
    if (ok && job) {
      log.info(`[cron] Removed job "${job.name}" (${job.id})`);
      this.emit({ type: "removed", jobId: job.id, jobName: job.name });
    }
    return ok;
  }

  getById(id: string): CronJob | null {
    return this.store.getById(id);
  }

  list(): CronJob[] {
    return this.store.list();
  }

  listByUser(userId: string): CronJob[] {
    return this.store.listByUser(userId);
  }

  /** Manually trigger a job regardless of schedule */
  async run(id: string): Promise<void> {
    const job = this.store.getById(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    await this.executeJob(job);
  }

  // -----------------------------------------------------------------------
  // Timer engine
  // -----------------------------------------------------------------------

  private armTimer(): void {
    if (!this.started) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextWake = this.store.nextWakeAt();
    if (nextWake == null) {
      log.debug("[cron] No pending jobs — timer idle");
      return;
    }

    const delay = Math.min(
      Math.max(nextWake - Date.now(), MIN_REFIRE_GAP_MS),
      MAX_TIMER_DELAY_MS,
    );

    log.debug(`[cron] Timer armed — next tick in ${Math.round(delay / 1000)}s`);
    this.timer = setTimeout(() => this.onTick(), delay);
    // Prevent timer from keeping process alive
    this.timer.unref();
  }

  private async onTick(): Promise<void> {
    if (!this.started) return;

    const now = Date.now();
    if (now - this.lastTickMs < MIN_REFIRE_GAP_MS) {
      this.armTimer();
      return;
    }
    this.lastTickMs = now;

    // Find due jobs
    const due = this.store.listDue(now);
    if (due.length === 0) {
      this.armTimer();
      return;
    }

    log.info(`[cron] Tick — ${due.length} job(s) due`);

    // Execute up to MAX_CONCURRENT, skip already running
    const toRun = due.filter((j) => !this.running.has(j.id)).slice(0, MAX_CONCURRENT - this.running.size);

    const promises = toRun.map((job) => this.executeJob(job).catch((err) => {
      log.error(`[cron] Unexpected error executing job "${job.name}":`, err);
    }));

    // Don't await — let jobs run in background, re-arm immediately
    Promise.allSettled(promises).then(() => this.armTimer());

    // Also re-arm for any remaining due jobs
    if (toRun.length < due.length) {
      this.armTimer();
    }
  }

  // -----------------------------------------------------------------------
  // Job execution
  // -----------------------------------------------------------------------

  private async executeJob(job: CronJob): Promise<void> {
    if (this.running.has(job.id)) {
      log.warn(`[cron] Job "${job.name}" already running — skipping`);
      return;
    }

    this.running.add(job.id);
    this.store.markStarted(job.id, Date.now());
    this.emit({ type: "started", jobId: job.id, jobName: job.name });

    const t0 = Date.now();
    let status: CronRunStatus = "ok";
    let error: string | undefined;

    try {
      await this.executePayload(job);
    } catch (err: any) {
      status = "error";
      error = err.message ?? String(err);
      log.error(`[cron] Job "${job.name}" failed:`, error);
    } finally {
      this.running.delete(job.id);
      const durationMs = Date.now() - t0;

      // Apply backoff for consecutive errors
      this.store.markFinished(job.id, status, error);

      if (status === "error") {
        const updated = this.store.getById(job.id);
        if (updated) {
          this.applyBackoff(updated);
        }
      }

      // Delete one-shot jobs after successful run
      if (status === "ok" && job.deleteAfterRun) {
        this.store.remove(job.id);
        log.info(`[cron] One-shot job "${job.name}" completed and removed`);
      }

      this.emit({
        type: "finished",
        jobId: job.id,
        jobName: job.name,
        status,
        durationMs,
        error,
      });

      log.info(`[cron] Job "${job.name}" finished: ${status} (${Math.round(durationMs / 1000)}s)`);
    }
  }

  private async executePayload(job: CronJob): Promise<void> {
    const { payload } = job;

    switch (payload.kind) {
      case "agent-turn": {
        const providerName = payload.provider ?? this.config.defaultProvider;
        const provider = this.config.registry.create(providerName);

        const result = await handleConversation({
          userId: job.userId,
          message: payload.prompt,
          channel: "cron",
          channelId: job.id,
          deps: {
            provider,
            sessionManager: this.config.sessionManager,
            eventLog: this.config.eventLog,
            memoryManager: this.config.memoryManager,
            maxHistoryTokens: this.config.maxHistoryTokens,
          },
        });

        if (result.error) {
          throw new Error(result.error);
        }

        log.info(`[cron] Job "${job.name}" agent reply: ${result.text.slice(0, 200)}`);
        break;
      }

      default:
        throw new Error(`Unknown payload kind: ${(payload as any).kind}`);
    }
  }

  private applyBackoff(job: CronJob): void {
    if (job.consecutiveErrors <= 0) return;
    if (job.schedule.kind === "at") return; // no backoff for one-shot

    const idx = Math.min(job.consecutiveErrors - 1, BACKOFF_MS.length - 1);
    const backoffMs = BACKOFF_MS[idx];
    const backoffNext = Date.now() + backoffMs;

    // Only push nextRunAt forward if backoff is later than the scheduled next
    const scheduledNext = computeNextRunAt(job.schedule, Date.now());
    if (scheduledNext && backoffNext > scheduledNext) {
      // Update nextRunAt in store directly
      this.config.db.prepare(
        `UPDATE cron_jobs SET next_run_at = ? WHERE id = ?`,
      ).run(backoffNext, job.id);

      log.warn(
        `[cron] Backoff: job "${job.name}" delayed ${Math.round(backoffMs / 1000)}s (${job.consecutiveErrors} consecutive errors)`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emit(event: CronEvent): void {
    try {
      this.config.onEvent?.(event);
    } catch {
      // best-effort
    }
  }
}
