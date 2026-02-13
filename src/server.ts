import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
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
import { chatRouter } from "./chat/router.js";
import { ClaudeProvider } from "./chat/claude-provider.js";
import { GenericProvider } from "./chat/generic-provider.js";
import { buildSystemPrompt } from "./chat/system-prompt.js";
import { createSentryQueryTool } from "./agent/tools/sentry-query.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ChatProvider } from "./chat/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(): { app: Hono; store: TaskStore; workflow: FaultHealingWorkflow | null } {
  const env = loadEnv();
  const db = createDb(resolve("ai-hub.db"));
  const store = new TaskStore(db);

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

  // --- Fault Healing Pipeline (requires Sentry + Lark + GitHub config) ---
  let workflow: FaultHealingWorkflow | null = null;

  if (env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT &&
      env.LARK_APP_ID && env.LARK_APP_SECRET && env.LARK_NOTIFY_CHAT_ID &&
      env.ANTHROPIC_API_KEY && env.GH_TOKEN) {
    const larkClient = getLarkClient({
      appId: env.LARK_APP_ID,
      appSecret: env.LARK_APP_SECRET,
    });

    const skillPath = resolve(__dirname, "skills", "fault-healing.md");
    const skillContent = readFileSync(skillPath, "utf-8");

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

    workflow = new FaultHealingWorkflow({
      store,
      runAgent: (prompt) => runAgent(prompt, agentConfig),
      sendLarkCard: (card) =>
        sendLarkCard(larkClient, env.LARK_NOTIFY_CHAT_ID!, card),
    });

    sentryWebhook(app, store, (taskId) => {
      workflow!.runAnalysis(taskId).catch((err) => {
        console.error(`[workflow] Analysis failed for task ${taskId}:`, err);
      });
    });

    larkCallback(app, store, (taskId, action) => {
      workflow!.handleAction(taskId, action).catch((err) => {
        console.error(`[workflow] Action "${action}" failed for task ${taskId}:`, err);
      });
    });

    console.log("[init] Fault healing pipeline enabled");
  } else {
    console.log("[init] Fault healing pipeline disabled (missing Sentry/Lark/GitHub config)");
  }

  // --- Chat Assistant ---
  // Build tools list for system prompt
  const chatTools: string[] = [];
  let chatMcpServers: Record<string, unknown> | undefined;

  if (env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT) {
    const sentryTool = createSentryQueryTool({
      authToken: env.SENTRY_AUTH_TOKEN,
      org: env.SENTRY_ORG,
      project: env.SENTRY_PROJECT,
    });
    const mcpServer = createSdkMcpServer({
      name: "ai-hub-tools",
      tools: [
        tool(
          sentryTool.name,
          sentryTool.description,
          sentryTool.inputSchema,
          sentryTool.handler,
        ),
      ],
    });
    chatMcpServers = { "ai-hub-tools": mcpServer };
    chatTools.push(
      "`sentry_query(issue_id)` — Query Sentry for issue details, stacktrace, affected users",
    );
  }

  // Build rich system prompt with project knowledge + skills
  const systemPrompt = buildSystemPrompt({
    workspaceDir: env.WORKSPACE_DIR,
    skillsDir: resolve(__dirname, "skills"),
    tools: chatTools,
  });

  let chatProvider: ChatProvider;
  if (env.CHAT_PROVIDER === "generic" && env.CHAT_API_BASE && env.CHAT_API_KEY) {
    chatProvider = new GenericProvider({
      baseUrl: env.CHAT_API_BASE,
      apiKey: env.CHAT_API_KEY,
      model: env.CHAT_MODEL ?? "deepseek-chat",
      systemPrompt,
    });
  } else {
    chatProvider = new ClaudeProvider({
      workspaceDir: env.WORKSPACE_DIR,
      skillContent: systemPrompt,
      env: env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {},
      mcpServers: chatMcpServers,
    });
  }

  chatRouter(app, chatProvider);

  // Serve static files (chat UI)
  app.use("/*", serveStatic({ root: resolve(__dirname, "public") }));

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

  Chat:    http://localhost:${info.port}/

  Webhooks:
    Sentry:  POST http://localhost:${info.port}/webhooks/sentry
    飞书:    POST http://localhost:${info.port}/callbacks/lark
`);
  });
}
