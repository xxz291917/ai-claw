import type { SessionManager } from "../sessions/manager.js";
import type { ChatEvent } from "./types.js";
import type { Session } from "../sessions/types.js";

type CommandContext = {
  session: Session;
  sessionManager: SessionManager;
  providerName: string;
};

type CommandResult = {
  events: ChatEvent[];
  newSession?: Session;
};

export function handleCommand(
  message: string,
  ctx: CommandContext,
): CommandResult | null {
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
    default:
      return null;
  }
}

function handleNew(ctx: CommandContext): CommandResult {
  const { session, sessionManager, providerName } = ctx;

  // Close current session
  sessionManager.close(session.id);

  // Create new session
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
