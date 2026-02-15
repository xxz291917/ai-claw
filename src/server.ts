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
import { createSkillReaderTool } from "./agent/tools/skill-reader.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDef } from "./chat/generic-provider.js";
import type { ChatProvider } from "./chat/types.js";

// New architecture imports
import { EventBus } from "./core/event-bus.js";
import { Core } from "./core/core.js";
import { RuleRouter } from "./core/rule-router.js";
import { Executor } from "./core/executor.js";
import { AgentRegistry } from "./agents/registry.js";
import { SessionManager } from "./sessions/manager.js";
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

  // Input adapters (used by future route migration; created now for wiring)
  const _sentryAdapter = new SentryInputAdapter();
  const _larkAdapter = new LarkInputAdapter();
  const webChatAdapter = new WebChatInputAdapter();

  // Agent registry (empty for now — sub-agents added in future tasks)
  const registry = new AgentRegistry([]);

  // Rule router (no routes yet — rules added in future tasks)
  const ruleRouter = new RuleRouter([]);

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
  const skillsDir = resolve(__dirname, "skills");
  const chatToolDescriptions: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mcpTools: Array<ReturnType<typeof tool<any>>> = [];
  const genericTools: ToolDef[] = [];

  // get_skill tool (always available)
  const skillReader = createSkillReaderTool(skillsDir);
  mcpTools.push(
    tool(skillReader.name, skillReader.description, skillReader.inputSchema, skillReader.handler),
  );
  genericTools.push({
    name: skillReader.name,
    description: skillReader.description,
    parameters: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Skill name (without .md extension)" },
      },
      required: ["skill_name"],
    },
    handler: skillReader.plainHandler,
  });
  chatToolDescriptions.push(
    "`get_skill(skill_name)` — Load full instructions for a skill by name",
  );

  // sentry_query tool (when Sentry config available)
  if (env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT) {
    const sentryTool = createSentryQueryTool({
      authToken: env.SENTRY_AUTH_TOKEN,
      org: env.SENTRY_ORG,
      project: env.SENTRY_PROJECT,
    });
    mcpTools.push(
      tool(sentryTool.name, sentryTool.description, sentryTool.inputSchema, sentryTool.handler),
    );
    genericTools.push({
      name: sentryTool.name,
      description: sentryTool.description,
      parameters: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "Sentry issue ID" },
        },
        required: ["issue_id"],
      },
      handler: async (args: { issue_id: string }) => {
        const result = await sentryTool.handler(args);
        return result.content[0].text;
      },
    });
    chatToolDescriptions.push(
      "`sentry_query(issue_id)` — Query Sentry for issue details, stacktrace, affected users",
    );
  }

  const chatMcpServers = {
    "ai-hub-tools": createSdkMcpServer({ name: "ai-hub-tools", tools: mcpTools }),
  };

  // Build rich system prompt with project knowledge + skills
  const systemPrompt = buildSystemPrompt({
    workspaceDir: env.WORKSPACE_DIR,
    skillsDir,
    tools: chatToolDescriptions,
  });

  let chatProvider: ChatProvider;
  if (env.CHAT_PROVIDER === "generic" && env.CHAT_API_BASE && env.CHAT_API_KEY) {
    chatProvider = new GenericProvider({
      baseUrl: env.CHAT_API_BASE,
      apiKey: env.CHAT_API_KEY,
      model: env.CHAT_MODEL ?? "deepseek-chat",
      systemPrompt,
      tools: genericTools,
    });
  } else {
    chatProvider = new ClaudeProvider({
      workspaceDir: env.WORKSPACE_DIR,
      skillContent: systemPrompt,
      env: env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {},
      mcpServers: chatMcpServers,
    });
  }

  chatRouter(app, chatProvider, { sessionManager, eventBus, webChatAdapter });

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
