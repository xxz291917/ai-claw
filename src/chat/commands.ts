import type { SessionManager } from "../sessions/manager.js";
import type { ChatEvent } from "./types.js";
import type { Session } from "../sessions/types.js";
import { installSkill, uninstallSkill, searchSkills } from "./clawhub.js";
import { scanSkillDirs } from "../skills/loader.js";

export type CommandContext = {
  session: Session;
  sessionManager: SessionManager;
  providerName: string;
  /** Absolute path to the writable skills install directory */
  installDir: string;
  /** All skill directories (for /skills listing) */
  skillsDirs: string[];
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
  const lines = skills.map(
    (s) => `- **${s.name}**: ${s.description}`,
  );
  return textResult(
    ctx.session.id,
    `Available skills (${skills.length}):\n\n${lines.join("\n")}\n\nUse \`/search <query>\` to find more on ClawHub.`,
  );
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
      "  `/help` — Show this help message",
    ].join("\n"),
  );
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
