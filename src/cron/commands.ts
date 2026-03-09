/**
 * Slash commands for managing cron jobs.
 *
 * /cron list                              — list all jobs
 * /cron add <name> <schedule> <prompt>    — add a job
 * /cron remove <id>                       — remove a job
 * /cron enable <id>                       — enable a job
 * /cron disable <id>                      — disable a job
 * /cron run <id>                          — manually trigger a job
 * /cron help                              — show usage
 */

import type { CronService } from "./service.js";
import type { ChatEvent } from "../chat/types.js";
import type { CronSchedule, CronJobInput } from "./types.js";
import { describeSchedule } from "./schedule.js";

type CronCommandResult = {
  events: ChatEvent[];
};

/**
 * Handle /cron subcommands.
 * Returns null if args don't match any subcommand.
 */
export function handleCronCommand(
  args: string[],
  userId: string,
  sessionId: string,
  cronService: CronService,
): CronCommandResult {
  const sub = args[0]?.toLowerCase();

  switch (sub) {
    case "list":
    case "ls":
      return cronList(userId, sessionId, cronService);
    case "add":
      return cronAdd(args.slice(1), userId, sessionId, cronService);
    case "remove":
    case "rm":
    case "delete":
      return cronRemove(args[1], sessionId, cronService);
    case "enable":
      return cronToggle(args[1], true, sessionId, cronService);
    case "disable":
      return cronToggle(args[1], false, sessionId, cronService);
    case "run":
      return cronRun(args[1], sessionId, cronService);
    case "help":
    default:
      return cronHelp(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function cronList(userId: string, sessionId: string, svc: CronService): CronCommandResult {
  const jobs = svc.listByUser(userId);
  if (jobs.length === 0) {
    return text(sessionId, "No cron jobs. Use `/cron add` to create one.");
  }

  const lines = jobs.map((j) => {
    const status = j.enabled ? "✅" : "⏸️";
    const schedule = describeSchedule(j.schedule);
    const lastRun = j.lastRunAt
      ? `last: ${new Date(j.lastRunAt).toLocaleString()} (${j.lastStatus ?? "?"})`
      : "never run";
    const nextRun = j.nextRunAt
      ? `next: ${new Date(j.nextRunAt).toLocaleString()}`
      : "no next run";
    const errors = j.consecutiveErrors > 0 ? ` ⚠️ ${j.consecutiveErrors} errors` : "";
    return `${status} **${j.name}** \`${j.id.slice(0, 8)}\`\n   ${schedule} | ${lastRun} | ${nextRun}${errors}\n   prompt: ${j.payload.kind === "agent-turn" ? j.payload.prompt.slice(0, 60) : "?"}`;
  });

  return text(sessionId, `**Cron jobs (${jobs.length}):**\n\n${lines.join("\n\n")}`);
}

function cronAdd(args: string[], userId: string, sessionId: string, svc: CronService): CronCommandResult {
  // Parse: /cron add <name> <schedule-type> <schedule-value> <prompt...>
  // Examples:
  //   /cron add daily-report cron "0 9 * * *" 生成每日报告
  //   /cron add check-every-hour every 3600000 检查系统状态
  //   /cron add one-time at 2026-03-10T09:00:00Z 提醒我开会

  if (args.length < 3) {
    return text(sessionId, [
      "Usage: `/cron add <name> <type> <value> <prompt...>`",
      "",
      "Schedule types:",
      "  `cron <expression>` — Cron expression (e.g. `\"0 9 * * *\"`)",
      "  `every <ms>` — Interval in milliseconds",
      "  `at <iso-datetime>` — One-shot at specific time",
      "",
      "Examples:",
      "  `/cron add daily-report cron \"0 9 * * *\" 生成每日报告`",
      "  `/cron add hourly-check every 3600000 检查系统状态`",
      "  `/cron add reminder at 2026-03-10T09:00:00Z 提醒我开会`",
    ].join("\n"));
  }

  const name = args[0];
  const schedType = args[1].toLowerCase();
  const schedValue = args[2];
  const prompt = args.slice(3).join(" ").trim();

  if (!prompt) {
    return text(sessionId, "Missing prompt. Usage: `/cron add <name> <type> <value> <prompt...>`");
  }

  let schedule: CronSchedule;
  let deleteAfterRun = false;

  switch (schedType) {
    case "cron":
      schedule = { kind: "cron", expr: schedValue };
      break;
    case "every": {
      const ms = parseInt(schedValue, 10);
      if (isNaN(ms) || ms <= 0) {
        return text(sessionId, "Invalid interval. Must be a positive number in milliseconds.");
      }
      schedule = { kind: "every", everyMs: ms };
      break;
    }
    case "at": {
      const d = new Date(schedValue);
      if (isNaN(d.getTime())) {
        return text(sessionId, "Invalid datetime. Use ISO 8601 format (e.g. `2026-03-10T09:00:00Z`).");
      }
      schedule = { kind: "at", at: d.toISOString() };
      deleteAfterRun = true;
      break;
    }
    default:
      return text(sessionId, `Unknown schedule type: "${schedType}". Use \`cron\`, \`every\`, or \`at\`.`);
  }

  const input: CronJobInput = {
    name,
    schedule,
    payload: { kind: "agent-turn", prompt },
    userId,
    deleteAfterRun,
  };

  try {
    const job = svc.add(input);
    return text(sessionId, [
      `Created cron job **${job.name}** (\`${job.id.slice(0, 8)}\`)`,
      `Schedule: ${describeSchedule(job.schedule)}`,
      `Next run: ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "none"}`,
      `Prompt: ${prompt.slice(0, 100)}`,
    ].join("\n"));
  } catch (err: any) {
    return text(sessionId, `Failed to add job: ${err.message}`);
  }
}

function cronRemove(idPrefix: string | undefined, sessionId: string, svc: CronService): CronCommandResult {
  if (!idPrefix) {
    return text(sessionId, "Usage: `/cron remove <job-id>`");
  }

  const job = findByPrefix(idPrefix, svc);
  if (!job) {
    return text(sessionId, `No job found matching \`${idPrefix}\`.`);
  }

  svc.remove(job.id);
  return text(sessionId, `Removed job **${job.name}** (\`${job.id.slice(0, 8)}\`).`);
}

function cronToggle(idPrefix: string | undefined, enabled: boolean, sessionId: string, svc: CronService): CronCommandResult {
  if (!idPrefix) {
    return text(sessionId, `Usage: \`/cron ${enabled ? "enable" : "disable"} <job-id>\``);
  }

  const job = findByPrefix(idPrefix, svc);
  if (!job) {
    return text(sessionId, `No job found matching \`${idPrefix}\`.`);
  }

  svc.update(job.id, { enabled });
  return text(sessionId, `Job **${job.name}** ${enabled ? "enabled" : "disabled"}.`);
}

function cronRun(idPrefix: string | undefined, sessionId: string, svc: CronService): CronCommandResult {
  if (!idPrefix) {
    return text(sessionId, "Usage: `/cron run <job-id>`");
  }

  const job = findByPrefix(idPrefix, svc);
  if (!job) {
    return text(sessionId, `No job found matching \`${idPrefix}\`.`);
  }

  // Fire-and-forget
  svc.run(job.id).catch(() => {});
  return text(sessionId, `Triggered job **${job.name}** — running in background.`);
}

function cronHelp(sessionId: string): CronCommandResult {
  return text(sessionId, [
    "**Cron commands:**",
    "  `/cron list` — List all your cron jobs",
    "  `/cron add <name> <type> <value> <prompt>` — Create a job",
    "  `/cron remove <id>` — Delete a job",
    "  `/cron enable <id>` — Enable a job",
    "  `/cron disable <id>` — Disable a job",
    "  `/cron run <id>` — Manually trigger a job",
    "",
    "Schedule types: `cron`, `every`, `at`",
    "Job IDs can be abbreviated (first 8 chars).",
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findByPrefix(prefix: string, svc: CronService): ReturnType<CronService["getById"]> {
  // Try exact match first
  const exact = svc.getById(prefix);
  if (exact) return exact;

  // Try prefix match
  const all = svc.list();
  const matches = all.filter((j) => j.id.startsWith(prefix));
  return matches.length === 1 ? matches[0] : null;
}

function text(sessionId: string, content: string): CronCommandResult {
  return {
    events: [
      { type: "text", content },
      { type: "done", sessionId, costUsd: 0 },
    ],
  };
}
