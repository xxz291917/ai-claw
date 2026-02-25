import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { chatRouter } from "./chat/router.js";
import { larkRouter } from "./lark/router.js";
import { createLarkClient, sendCard, patchCard } from "./lark/client.js";
import { parseChatUsers, chatAuthMiddleware } from "./chat/auth.js";
import { setupChatProvider } from "./chat/setup.js";
import { buildToolSuite } from "./tools/suite.js";
import { scanSkillDirs } from "./skills/loader.js";
import { formatMissingReason } from "./skills/eligibility.js";
import { EventLog } from "./core/event-bus.js";
import { SessionManager } from "./sessions/manager.js";
import { MemoryManager } from "./memory/manager.js";
import type Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(): {
  app: Hono;
  db: Database.Database;
  eventLog: EventLog;
} {
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
    console.log(`[init] Chat auth enabled (${chatUsers.size} users)`);
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
  console.log(`[init] Skills: ${eligibleSkills.length} available, ${skippedSkills.length} skipped`);
  for (const s of eligibleSkills) {
    console.log(`[init]   + ${s.name}`);
  }
  for (const s of skippedSkills) {
    console.log(`[init]   - ${s.name} (${formatMissingReason(s.eligibility)})`);
  }

  // --- Tool Suite ---
  const toolSuite = buildToolSuite(env, skillsDirs, memoryManager);

  // --- Chat Assistant ---
  const { provider: chatProvider } = setupChatProvider(env, skillsDirs, toolSuite, memoryManager);
  chatRouter(app, chatProvider, {
    sessionManager,
    eventLog,
    memoryManager,
    maxHistoryTokens: env.CHAT_MAX_HISTORY_TOKENS,
    skillsDirs,
  });

  // --- Lark Bot (optional) ---
  if (env.LARK_APP_ID && env.LARK_APP_SECRET) {
    const larkClient = createLarkClient(env);
    larkRouter(app, {
      provider: chatProvider,
      sessionManager,
      eventLog,
      memoryManager,
      maxHistoryTokens: env.CHAT_MAX_HISTORY_TOKENS,
      sendCard: (chatId, markdown) => sendCard(larkClient, chatId, markdown),
      patchCard: (messageId, markdown) => patchCard(larkClient, messageId, markdown),
      verificationToken: env.LARK_VERIFICATION_TOKEN,
    });
    console.log("[init] Lark bot enabled");
  }

  // Serve static files (chat UI)
  app.use("/*", serveStatic({ root: resolve(__dirname, "public") }));

  return { app, db, eventLog };
}

export function startServer() {
  const { app } = createApp();
  const env = loadEnv(); // singleton — already parsed by createApp()

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`
AI Claw 服务已启动

  地址:     http://localhost:${info.port}
  健康检查: http://localhost:${info.port}/health
  Chat:     http://localhost:${info.port}/
  Lark:     ${env.LARK_APP_ID ? "POST http://localhost:" + info.port + "/api/lark/webhook" : "(disabled)"}
`);
  });
}
