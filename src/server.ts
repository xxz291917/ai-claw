import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { runAgent } from "./agent/runner.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
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

  // Task status
  app.get("/tasks/:id", (c) => {
    const row = db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(c.req.param("id")) as Record<string, any> | undefined;
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  // --- Shared Tool Suite (used by both Fault Healing and Chat) ---
  const skillsDir = resolve(__dirname, "skills");
  const toolSuite = buildToolSuite(env, skillsDir);

  // --- Fault Healing Pipeline (agent autonomy) ---
  if (env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT &&
      env.ANTHROPIC_API_KEY && env.GH_TOKEN) {
    const skillPath = resolve(__dirname, "skills", "fault-healing.md");
    const skillContent = readFileSync(skillPath, "utf-8");
    const fhSystemPrompt = skillContent +
      "\n\n## Available Tools\n\n" +
      toolSuite.descriptions.map((d) => `- ${d}`).join("\n");

    registerWebhookRoutes(app, {
      db,
      eventLog,
      runFaultHealing: (prompt) =>
        runAgent(prompt, {
          workspaceDir: env.WORKSPACE_DIR,
          systemPrompt: fhSystemPrompt,
          mcpServers: toolSuite.mcpServers,
          env: { GH_TOKEN: env.GH_TOKEN! },
        }),
    });

    console.log("[init] Fault healing pipeline enabled (agent autonomy)");
  } else {
    console.log("[init] Fault healing pipeline disabled (missing config)");
  }

  // --- Chat Assistant (reuses shared tool suite) ---
  const { provider: chatProvider } = setupChatProvider(env, skillsDir, toolSuite);
  chatRouter(app, chatProvider, { sessionManager, eventLog, memoryManager });

  // Serve static files (chat UI)
  app.use("/*", serveStatic({ root: resolve(__dirname, "public") }));

  return { app, db, eventLog };
}

export function startServer() {
  const env = loadEnv();
  const { app } = createApp();

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`
AI Hub 服务已启动

  地址:     http://localhost:${info.port}
  健康检查: http://localhost:${info.port}/health

  Chat:    http://localhost:${info.port}/

  Webhooks:
    Sentry:  POST http://localhost:${info.port}/webhooks/sentry
`);
  });
}
