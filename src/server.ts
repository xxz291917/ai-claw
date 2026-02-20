import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { TaskStore } from "./tasks/store.js";
import { runAgent } from "./agent/runner.js";
import { getLarkClient, sendLarkCard } from "./lark/notify.js";
import { FaultHealingWorkflow } from "./workflows/fault-healing.js";
import { FaultHealingAgent } from "./agents/fault-healing.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { faultHealingRoutes } from "./routes/fault-healing.js";
import { chatRouter } from "./chat/router.js";
import { parseChatUsers, chatAuthMiddleware } from "./chat/auth.js";
import { setupChatProvider } from "./chat/setup.js";
import { buildToolSuite } from "./tools/suite.js";

// New architecture imports
import { EventBus } from "./core/event-bus.js";
import { Core } from "./core/core.js";
import { RuleRouter } from "./core/rule-router.js";
import { Executor } from "./core/executor.js";
import { AgentRegistry } from "./agents/registry.js";
import { SessionManager } from "./sessions/manager.js";
import { MemoryManager } from "./memory/manager.js";
import { SentryInputAdapter } from "./adapters/input/sentry.js";
import { LarkInputAdapter } from "./adapters/input/lark.js";
import { WebChatInputAdapter } from "./adapters/input/web-chat.js";
import type { HubEvent } from "./core/hub-event.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp(): {
  app: Hono;
  store: TaskStore;
  workflow: FaultHealingWorkflow | null;
  eventBus: EventBus;
  core: Core;
} {
  const env = loadEnv();
  const db = createDb(resolve("data/ai-hub.db"));
  const store = new TaskStore(db);

  // --- New Architecture: EventBus + Adapters + Core ---
  const eventBus = new EventBus(db);
  const sessionManager = new SessionManager(db);
  const memoryManager = new MemoryManager(db);

  // Input adapters
  const sentryAdapter = new SentryInputAdapter();
  const larkAdapter = new LarkInputAdapter();
  const webChatAdapter = new WebChatInputAdapter();

  // Agent registry (agents registered conditionally below)
  const registry = new AgentRegistry([]);

  // Rule router with fault-healing routes
  const ruleRouter = new RuleRouter(faultHealingRoutes);

  // Executor
  const executor = new Executor({
    registry,
    db,
    outputSend: async (_action, _agentEvent) => {
      // Output adapters will be wired in a future task
    },
  });

  // Chat handler callback for Core (placeholder — actual chat still uses chatRouter)
  const handleChat = async (event: HubEvent) => {
    // For now, just log that we received a chat event via the new architecture
    // The actual chat handling still goes through the existing chatRouter
    console.log(`[core] Chat event received: ${event.type} from ${event.source}`);
  };

  // Core orchestrator
  const core = new Core({ ruleRouter, executor, sessionManager, handleChat });

  // Subscribe Core to all events
  eventBus.on("*", (event) => core.handle(event));

  console.log("[init] New architecture wired (EventBus + Adapters + Core)");

  // Build Hono app
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
    const task = store.getById(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    return c.json(task);
  });

  // --- Shared Tool Suite (used by both Fault Healing and Chat) ---
  const skillsDir = resolve(__dirname, "skills");
  const toolSuite = buildToolSuite(env, skillsDir);

  // --- Fault Healing Pipeline (EventBus-integrated) ---
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
    const fhSystemPrompt = skillContent +
      "\n\n## Available Tools\n\n" +
      toolSuite.descriptions.map((d) => `- ${d}`).join("\n");

    workflow = new FaultHealingWorkflow({
      store,
      runAgent: (prompt) =>
        runAgent(prompt, {
          workspaceDir: env.WORKSPACE_DIR,
          systemPrompt: fhSystemPrompt,
          mcpServers: toolSuite.mcpServers,
          env: { GH_TOKEN: env.GH_TOKEN! },
        }),
      sendLarkCard: (card) =>
        sendLarkCard(larkClient, env.LARK_NOTIFY_CHAT_ID!, card),
    });

    // Register SubAgent in the EventBus architecture
    registry.register(new FaultHealingAgent({ workflow, store }));

    // Register webhook routes (EventBus-integrated)
    registerWebhookRoutes(app, {
      store,
      eventBus,
      sentryAdapter,
      larkAdapter,
    });

    console.log("[init] Fault healing pipeline enabled (EventBus)");
  } else {
    console.log("[init] Fault healing pipeline disabled (missing Sentry/Lark/GitHub config)");
  }

  // --- Chat Assistant (reuses shared tool suite) ---
  const { provider: chatProvider } = setupChatProvider(env, skillsDir, toolSuite);
  chatRouter(app, chatProvider, { sessionManager, eventBus, webChatAdapter, memoryManager });

  // Serve static files (chat UI)
  app.use("/*", serveStatic({ root: resolve(__dirname, "public") }));

  return { app, store, workflow, eventBus, core };
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
