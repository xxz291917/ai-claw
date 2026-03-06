import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { WebChannel } from "./channels/web.js";
import { ChannelManager } from "./channels/manager.js";
import type { ChannelContext } from "./channels/types.js";
import { handleConversation } from "./chat/conversation.js";
import { LarkChannel } from "./channels/lark.js";
import { createLarkClient, sendCard, patchCard } from "./lark/client.js";
import { parseChatUsers, chatAuthMiddleware } from "./chat/auth.js";
import { setupChatProvider } from "./chat/setup.js";
import { buildToolSuite } from "./tools/suite.js";
import { scanSkillDirs } from "./skills/loader.js";
import { formatMissingReason } from "./skills/eligibility.js";
import { EventLog } from "./core/event-bus.js";
import { SessionManager } from "./sessions/manager.js";
import { MemoryManager } from "./memory/manager.js";
import { SubagentManager } from "./subagent/manager.js";
import { loadMcpConfig } from "./mcp/config.js";
import { bridgeMcpTools } from "./mcp/bridge.js";
import { log } from "./logger.js";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createApp(): Promise<{
  app: Hono;
  db: Database.Database;
  eventLog: EventLog;
}> {
  const env = loadEnv();
  const db = createDb(resolve("data/ai-claw.db"));
  const eventLog = new EventLog(db);
  const sessionManager = new SessionManager(db);
  const memoryManager = new MemoryManager(db);

  const app = new Hono();

  // --- Chat Auth ---
  const chatUsers = parseChatUsers(env.CHAT_USERS);
  app.use("/api/chat", chatAuthMiddleware(chatUsers));
  if (chatUsers.size > 0) {
    log.info(`[init] Chat auth enabled (${chatUsers.size} users)`);
  }

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // --- Skills Directories (builtin + extra) ---
  const skillsDirs = [
    resolve(__dirname, "skills"),
    ...env.SKILLS_EXTRA_DIRS.split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => resolve(d)),
  ];

  // --- Skill Eligibility ---
  const allSkills = scanSkillDirs(skillsDirs);
  const eligibleSkills = allSkills.filter((s) => s.eligibility.eligible);
  const skippedSkills = allSkills.filter((s) => !s.eligibility.eligible);
  log.info(`[init] Skills: ${eligibleSkills.length} available, ${skippedSkills.length} skipped`);
  for (const s of eligibleSkills) {
    log.info(`[init]   + ${s.name}`);
  }
  for (const s of skippedSkills) {
    log.info(`[init]   - ${s.name} (${formatMissingReason(s.eligibility)})`);
  }

  // --- External MCP Servers ---
  const mcpConfig = loadMcpConfig(process.cwd());
  const mcpBridge = await bridgeMcpTools(mcpConfig);
  if (mcpBridge.connected.length > 0 || mcpBridge.skipped.length > 0) {
    log.info(`[init] MCP servers: ${mcpBridge.connected.length} connected, ${mcpBridge.skipped.length} skipped`);
  }
  for (const s of mcpBridge.connected) {
    log.info(`[init]   + ${s.name} (${s.toolCount} tools)`);
  }
  for (const s of mcpBridge.skipped) {
    log.warn(`[init]   - ${s.name} (${s.reason} — skipped)`);
  }

  // --- SubagentManager (created early; registry is set lazily via getter since
  //     spawn() is only called at runtime, long after init completes) ---
  let registry: import("./chat/provider-registry.js").ProviderRegistry;
  const subagentManager = new SubagentManager({
    get registry() { return registry; },
    sessionManager,
  });

  // --- Tool Suite (includes spawn tool) ---
  const toolSuite = buildToolSuite(env, skillsDirs, memoryManager, {
    subagentManager,
    defaultProvider: env.CHAT_PROVIDER,
    extraTools: mcpBridge.tools,
  });

  // --- Chat Assistant ---
  const setup = setupChatProvider(env, skillsDirs, toolSuite, memoryManager, mcpBridge.claudeServerConfigs);
  const chatProvider = setup.provider;
  registry = setup.registry;

  // --- Channels ---
  const channelManager = new ChannelManager();

  // Always register web channel
  channelManager.register(new WebChannel({
    provider: chatProvider,
    maxHistoryTokens: env.CHAT_MAX_HISTORY_TOKENS,
    skillsDirs,
    subagentManager,
  }));

  // Optionally register lark channel
  if (env.LARK_APP_ID && env.LARK_APP_SECRET) {
    const larkClient = createLarkClient(env);
    channelManager.register(new LarkChannel({
      provider: chatProvider,
      maxHistoryTokens: env.CHAT_MAX_HISTORY_TOKENS,
      sendCard: (chatId, markdown) => sendCard(larkClient, chatId, markdown),
      patchCard: (messageId, markdown) => patchCard(larkClient, messageId, markdown),
      verificationToken: env.LARK_VERIFICATION_TOKEN,
    }));
  }

  const channelCtx: ChannelContext = {
    app,
    sessionManager,
    eventLog,
    memoryManager,
    handleMessage: async (msg, onEvent) => {
      return handleConversation({
        userId: msg.userId,
        message: msg.text,
        sessionId: msg.sessionId,
        channel: msg.channel,
        channelId: msg.channelId,
        deps: {
          provider: chatProvider,
          sessionManager,
          eventLog,
          memoryManager,
          maxHistoryTokens: env.CHAT_MAX_HISTORY_TOKENS,
        },
        onEvent,
      });
    },
  };

  // Start all registered channels (current implementations are sync)
  channelManager.startAll(channelCtx);
  log.info(`[init] Channels: ${channelManager.list().join(", ")}`);

  // Serve static files (chat UI)
  app.use("/*", serveStatic({ root: resolve(__dirname, "public") }));

  return { app, db, eventLog };
}

export async function startServer() {
  const { app } = await createApp();
  const env = loadEnv(); // singleton — already parsed by createApp()

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    log.info(`
AI Claw 服务已启动

  地址:     http://localhost:${info.port}
  健康检查: http://localhost:${info.port}/health
  Chat:     http://localhost:${info.port}/
  Lark:     ${env.LARK_APP_ID ? "POST http://localhost:" + info.port + "/api/lark/webhook" : "(disabled)"}
`);
  });
}
