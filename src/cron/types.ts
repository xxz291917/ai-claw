/**
 * Cron job type definitions.
 * Schedule types inspired by OpenClaw (at / every / cron).
 */

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** One-shot: fire at a specific ISO 8601 datetime */
export type AtSchedule = { kind: "at"; at: string };

/** Interval: fire every N ms (optional anchor for alignment) */
export type EverySchedule = { kind: "every"; everyMs: number; anchorMs?: number };

/** Cron expression with optional timezone */
export type CronExprSchedule = { kind: "cron"; expr: string; tz?: string };

export type CronSchedule = AtSchedule | EverySchedule | CronExprSchedule;

// ---------------------------------------------------------------------------
// Job payload — what to execute when the job fires
// ---------------------------------------------------------------------------

export type AgentTurnPayload = {
  kind: "agent-turn";
  prompt: string;
  /** Provider to use (defaults to env CHAT_PROVIDER) */
  provider?: string;
};

export type CronPayload = AgentTurnPayload;

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export type CronRunStatus = "ok" | "error" | "skipped";

export type CronJob = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  userId: string;
  /** Delete job after first successful run (for one-shot "at" jobs) */
  deleteAfterRun: boolean;
  createdAt: string;
  updatedAt: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: CronRunStatus | null;
  lastError: string | null;
  consecutiveErrors: number;
};

export type CronJobInput = {
  name: string;
  schedule: CronSchedule;
  payload: CronPayload;
  userId: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
};

export type CronJobPatch = Partial<Pick<CronJobInput, "name" | "schedule" | "payload" | "enabled" | "deleteAfterRun">>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type CronEvent =
  | { type: "started"; jobId: string; jobName: string }
  | { type: "finished"; jobId: string; jobName: string; status: CronRunStatus; durationMs: number; error?: string }
  | { type: "added"; jobId: string; jobName: string }
  | { type: "removed"; jobId: string; jobName: string };
