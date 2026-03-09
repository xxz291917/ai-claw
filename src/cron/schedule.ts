/**
 * Next-run computation for all schedule kinds.
 * Uses `croner` for cron expression parsing (same lib as OpenClaw).
 */

import { Cron } from "croner";
import type { CronSchedule } from "./types.js";

// Cache parsed Cron instances (cron expressions are expensive to parse)
const cronCache = new Map<string, Cron>();
const MAX_CACHE = 256;

function getCron(expr: string, tz?: string): Cron {
  const key = `${expr}|${tz ?? ""}`;
  let c = cronCache.get(key);
  if (!c) {
    if (cronCache.size >= MAX_CACHE) {
      // Evict oldest entry
      const first = cronCache.keys().next().value!;
      cronCache.delete(first);
    }
    c = new Cron(expr, { timezone: tz });
    cronCache.set(key, c);
  }
  return c;
}

/**
 * Compute the next run time in epoch ms, or null if the schedule has no future run.
 */
export function computeNextRunAt(schedule: CronSchedule, nowMs: number): number | null {
  switch (schedule.kind) {
    case "at": {
      const atMs = new Date(schedule.at).getTime();
      return atMs > nowMs ? atMs : null;
    }

    case "every": {
      const { everyMs, anchorMs } = schedule;
      if (everyMs <= 0) return null;
      if (anchorMs != null) {
        // Align to anchor
        const elapsed = nowMs - anchorMs;
        const periods = Math.ceil(elapsed / everyMs);
        return anchorMs + periods * everyMs;
      }
      return nowMs + everyMs;
    }

    case "cron": {
      try {
        const c = getCron(schedule.expr, schedule.tz);
        const next = c.nextRun(new Date(nowMs));
        return next ? next.getTime() : null;
      } catch {
        return null;
      }
    }
  }
}

/**
 * Human-readable description of a schedule.
 */
export function describeSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case "at":
      return `once at ${schedule.at}`;
    case "every": {
      const secs = schedule.everyMs / 1000;
      if (secs < 60) return `every ${secs}s`;
      if (secs < 3600) return `every ${Math.round(secs / 60)}m`;
      return `every ${Math.round(secs / 3600)}h`;
    }
    case "cron":
      return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ""}`;
  }
}
