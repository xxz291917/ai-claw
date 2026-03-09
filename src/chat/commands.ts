import type { SessionManager } from "../sessions/manager.js";
import type { ChatEvent } from "./types.js";
import type { Session } from "../sessions/types.js";
import type { SubagentManager } from "../subagent/manager.js";
import type { UserSettingsManager } from "../settings/manager.js";
import type { CronService } from "../cron/service.js";
import { installSkill, uninstallSkill, searchSkills } from "./clawhub.js";
import { scanSkillDirs } from "../skills/loader.js";
import { formatMissingReason } from "../skills/eligibility.js";
import { handleCronCommand } from "../cron/commands.js";

export type CommandContext = {
  session: Session;
  sessionManager: SessionManager;
  providerName: string;
  /** Absolute path to the writable skills install directory */
  installDir: string;
  /** All skill directories (for /skills listing) */
  skillsDirs: string[];
  subagentManager?: SubagentManager;
  userSettingsManager?: UserSettingsManager;
  cronService?: CronService;
};

type CommandResult = {
  events: ChatEvent[];
  newSession?: Session;
};

export async function handleCommand(
  message: string,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return null;

  const [cmd, ...args] = trimmed.split(/\s+/);
  const command = cmd.toLowerCase();

  switch (command) {
    case "/new":
      return handleNew(ctx);
    case "/reset":
      return handleReset(ctx);
    case "/status":
      return handleStatus(ctx);
    case "/skills":
      return handleSkills(ctx);
    case "/help":
      return handleHelp(ctx);
    case "/install":
      return handleInstall(args, ctx);
    case "/uninstall":
      return handleUninstall(args, ctx);
    case "/search":
      return handleSearch(args, ctx);
    case "/tasks":
      return handleTasks(ctx);
    case "/stop":
      return handleStop(ctx);
    case "/prompt":
      return handlePrompt(args, ctx);
    case "/cron":
      return handleCron(args, ctx);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Session commands
// ---------------------------------------------------------------------------

function handleNew(ctx: CommandContext): CommandResult {
  const { session, sessionManager, providerName } = ctx;

  sessionManager.close(session.id);

  const newSession = sessionManager.create({
    userId: session.userId,
    channel: session.channel,
    channelId: session.channelId,
    provider: providerName,
  });

  return {
    events: [
      { type: "text", content: "New session started." },
      { type: "done", sessionId: newSession.id, costUsd: 0 },
    ],
    newSession,
  };
}

function handleReset(ctx: CommandContext): CommandResult {
  const { session, sessionManager } = ctx;

  const count = sessionManager.countMessages(session.id);
  sessionManager.clearMessages(session.id);

  return {
    events: [
      { type: "text", content: `Session reset. ${count} messages cleared.` },
      { type: "done", sessionId: session.id, costUsd: 0 },
    ],
  };
}

function handleStatus(ctx: CommandContext): CommandResult {
  const { session, sessionManager } = ctx;

  const count = sessionManager.countMessages(session.id);
  const lines = [
    `Session: ${session.id}`,
    `Provider: ${session.provider}`,
    `Channel: ${session.channel}`,
    `Messages: ${count}`,
    `Status: ${session.status}`,
    `Created: ${session.createdAt}`,
    `Last active: ${session.lastActiveAt}`,
  ];

  return {
    events: [
      { type: "text", content: lines.join("\n") },
      { type: "done", sessionId: session.id, costUsd: 0 },
    ],
  };
}

function handleSkills(ctx: CommandContext): CommandResult {
  const skills = scanSkillDirs(ctx.skillsDirs);
  if (skills.length === 0) {
    return textResult(ctx.session.id, "No skills installed.");
  }

  const available = skills.filter((s) => s.eligibility.eligible);
  const unavailable = skills.filter((s) => !s.eligibility.eligible);
  const lines: string[] = [];

  if (available.length > 0) {
    lines.push(`**Available skills (${available.length}):**\n`);
    for (const s of available) {
      const tagStr = s.tags?.length ? ` [${s.tags.join(", ")}]` : "";
      lines.push(`- **${s.name}**: ${s.description}${tagStr}`);
    }
  }

  if (unavailable.length > 0) {
    if (available.length > 0) lines.push("");
    lines.push(`**Unavailable skills (${unavailable.length}):**\n`);
    for (const s of unavailable) {
      lines.push(`- **${s.name}**: ${formatMissingReason(s.eligibility)}`);
    }
  }

  lines.push("", `Use \`/search <query>\` to find more on ClawHub.`);

  return textResult(ctx.session.id, lines.join("\n"));
}

function handleHelp(ctx: CommandContext): CommandResult {
  return textResult(
    ctx.session.id,
    [
      "Available commands:",
      "  `/new` — Start a new session",
      "  `/reset` — Clear current session messages",
      "  `/status` — Show session info",
      "  `/skills` — List all available skills",
      "  `/install <slug>` — Install a skill from ClawHub",
      "  `/uninstall <slug>` — Remove an installed skill",
      "  `/search <query>` — Search ClawHub for skills",
      "  `/tasks` — List background tasks",
      "  `/stop` — Cancel all running background tasks",
      "  `/prompt show` — Show your custom system prompt",
      "  `/prompt set <text>` — Set a custom system prompt",
      "  `/prompt clear` — Remove your custom system prompt",
      "  `/cron` — Manage scheduled tasks (list/add/remove/enable/disable/run)",
      "  `/help` — Show this help message",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// User settings commands
// ---------------------------------------------------------------------------

function handlePrompt(args: string[], ctx: CommandContext): CommandResult {
  const { session, userSettingsManager } = ctx;
  if (!userSettingsManager) {
    return textResult(session.id, "User settings not available.");
  }

  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "show") {
    const prompt = userSettingsManager.getCustomPrompt(session.userId);
    if (!prompt) {
      return textResult(session.id, "No custom prompt set. Use `/prompt set <text>` to add one.");
    }
    return textResult(session.id, `**Your custom prompt:**\n\n${prompt}`);
  }

  if (sub === "clear") {
    userSettingsManager.clearCustomPrompt(session.userId);
    return textResult(session.id, "Custom prompt cleared.");
  }

  if (sub === "set") {
    const text = args.slice(1).join(" ").trim();
    if (!text) {
      return textResult(session.id, "Usage: `/prompt set <your prompt text>`");
    }
    userSettingsManager.setCustomPrompt(session.userId, text);
    return textResult(session.id, `Custom prompt saved:\n\n${text}`);
  }

  return textResult(session.id, "Usage: `/prompt [show | set <text> | clear]`");
}

// ---------------------------------------------------------------------------
// Subagent task commands
// ---------------------------------------------------------------------------

function handleTasks(ctx: CommandContext): CommandResult {
  if (!ctx.subagentManager) {
    return textResult(ctx.session.id, "Background tasks not available.");
  }
  const tasks = ctx.subagentManager.listBySession(ctx.session.id);
  if (tasks.length === 0) {
    return textResult(ctx.session.id, "No background tasks.");
  }
  const lines = tasks.map((t) => {
    const elapsed = t.completedAt
      ? `${Math.round((t.completedAt - t.createdAt) / 1000)}s`
      : `${Math.round((Date.now() - t.createdAt) / 1000)}s`;
    return `- [${t.status}] ${t.task.slice(0, 80)} (${elapsed})`;
  });
  return textResult(ctx.session.id, `Background tasks (${tasks.length}):\n${lines.join("\n")}`);
}

function handleStop(ctx: CommandContext): CommandResult {
  if (!ctx.subagentManager) {
    return textResult(ctx.session.id, "Background tasks not available.");
  }
  const count = ctx.subagentManager.cancelBySession(ctx.session.id);
  return textResult(ctx.session.id, count > 0
    ? `${count} task(s) cancelled.`
    : "No running tasks to cancel.");
}

// ---------------------------------------------------------------------------
// Cron commands
// ---------------------------------------------------------------------------

function handleCron(args: string[], ctx: CommandContext): CommandResult {
  if (!ctx.cronService) {
    return textResult(ctx.session.id, "Cron scheduler not available.");
  }
  return handleCronCommand(args, ctx.session.userId, ctx.session.id, ctx.cronService);
}

// ---------------------------------------------------------------------------
// ClawHub skill commands
// ---------------------------------------------------------------------------

async function handleInstall(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const slug = args[0]?.trim();
  if (!slug) {
    return textResult(ctx.session.id, "Usage: `/install <skill-slug>`\nExample: `/install github`");
  }

  try {
    const { tag, alreadyInstalled } = await installSkill(ctx.installDir, slug);
    if (alreadyInstalled) {
      return textResult(
        ctx.session.id,
        `Skill "${slug}" is already at the latest version (${tag}).`,
      );
    }
    return textResult(
      ctx.session.id,
      `Installed **${slug}** (${tag}). The skill is now available — no restart needed.`,
    );
  } catch (err: any) {
    return textResult(ctx.session.id, `Install failed: ${err.message}`);
  }
}

async function handleUninstall(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const slug = args[0]?.trim();
  if (!slug) {
    return textResult(ctx.session.id, "Usage: `/uninstall <skill-slug>`\nExample: `/uninstall github`");
  }

  try {
    uninstallSkill(ctx.installDir, slug);
    return textResult(ctx.session.id, `Uninstalled **${slug}**.`);
  } catch (err: any) {
    return textResult(ctx.session.id, `Uninstall failed: ${err.message}`);
  }
}

async function handleSearch(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  const query = args.join(" ").trim();
  if (!query) {
    return textResult(ctx.session.id, "Usage: `/search <query>`\nExample: `/search github pull request`");
  }

  try {
    const results = await searchSkills(query);
    if (results.length === 0) {
      return textResult(ctx.session.id, `No skills found for "${query}".`);
    }
    const lines = results.map((r) => {
      const tags = r.tags?.length ? ` [${r.tags.join(", ")}]` : "";
      return `- **${r.slug}**: ${r.description}${tags}`;
    });
    return textResult(
      ctx.session.id,
      `Found ${results.length} skill(s) for "${query}":\n\n${lines.join("\n")}\n\nUse \`/install <slug>\` to install.`,
    );
  } catch (err: any) {
    return textResult(ctx.session.id, `Search failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(sessionId: string, content: string): CommandResult {
  return {
    events: [
      { type: "text", content },
      { type: "done", sessionId, costUsd: 0 },
    ],
  };
}
