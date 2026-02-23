import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { chatRouter } from "./chat/router.js";
import { parseChatUsers, chatAuthMiddleware } from "./chat/auth.js";
import { setupChatProvider } from "./chat/setup.js";
import { buildToolSuite } from "./tools/suite.js";
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
  const db = createDb(resolve("data/ai-hub.db"));
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

  // --- Tool Suite ---
  const toolSuite = buildToolSuite(env, skillsDirs);

  // --- Chat Assistant ---
  const { provider: chatProvider } = setupChatProvider(env, skillsDirs, toolSuite);
  chatRouter(app, chatProvider, {
    sessionManager,
    eventLog,
    memoryManager,
    maxHistoryTokens: env.CHAT_MAX_HISTORY_TOKENS,
  });

  // Serve static files (chat UI)
  app.use("/*", serveStatic({ root: resolve(__dirname, "public") }));

  return { app, db, eventLog };
}

export function startServer() {
  const { app } = createApp();
  const env = loadEnv(); // singleton — already parsed by createApp()

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`
AI Hub 服务已启动

  地址:     http://localhost:${info.port}
  健康检查: http://localhost:${info.port}/health
  Chat:     http://localhost:${info.port}/
`);
  });
}
