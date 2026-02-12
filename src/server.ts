import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { TaskStore } from "./tasks/store.js";
import { sentryWebhook } from "./webhooks/sentry.js";
import { runAgent } from "./agent/runner.js";
import { getLarkClient, sendLarkCard } from "./lark/notify.js";
import { larkCallback } from "./lark/callback.js";
import { FaultHealingWorkflow } from "./workflows/fault-healing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(): { app: Hono; store: TaskStore; workflow: FaultHealingWorkflow } {
  const env = loadEnv();
  const db = createDb(resolve("ai-hub.db"));
  const store = new TaskStore(db);
  const larkClient = getLarkClient({
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
  });

  // Load skill content
  const skillPath = resolve(__dirname, "skills", "fault-healing.md");
  const skillContent = readFileSync(skillPath, "utf-8");

  // Build agent config
  const agentConfig = {
    workspaceDir: env.WORKSPACE_DIR,
    sentryConfig: {
      authToken: env.SENTRY_AUTH_TOKEN,
      org: env.SENTRY_ORG,
      project: env.SENTRY_PROJECT,
    },
    skillContent,
    env: { GH_TOKEN: env.GH_TOKEN },
  };

  // Create workflow
  const workflow = new FaultHealingWorkflow({
    store,
    runAgent: (prompt) => runAgent(prompt, agentConfig),
    sendLarkCard: (card) =>
      sendLarkCard(larkClient, env.LARK_NOTIFY_CHAT_ID, card),
  });

  // Build Hono app
  const app = new Hono();

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // Task status
  app.get("/tasks/:id", (c) => {
    const task = store.getById(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  // Sentry webhook — triggers analysis asynchronously
  sentryWebhook(app, store, (taskId) => {
    workflow.runAnalysis(taskId).catch((err) => {
      console.error(
        `[workflow] Analysis failed for task ${taskId}:`,
        err,
      );
    });
  });

  // Lark callback — handles button clicks
  larkCallback(app, store, (taskId, action) => {
    workflow.handleAction(taskId, action).catch((err) => {
      console.error(
        `[workflow] Action "${action}" failed for task ${taskId}:`,
        err,
      );
    });
  });

  return { app, store, workflow };
}

export function startServer() {
  const env = loadEnv();
  const { app } = createApp();

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`
AI Hub 服务已启动

  地址:     http://localhost:${info.port}
  健康检查: http://localhost:${info.port}/health

  Webhooks:
    Sentry:  POST http://localhost:${info.port}/webhooks/sentry
    飞书:    POST http://localhost:${info.port}/callbacks/lark
`);
  });
}
