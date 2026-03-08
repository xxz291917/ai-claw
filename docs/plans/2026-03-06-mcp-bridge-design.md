# MCP Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the Chat Assistant to use external MCP servers (SSE/HTTP) as tool sources, with GenericProvider bridging via MCP Client and ClaudeProvider using native SDK passthrough.

**Architecture:** A `mcp-servers.json` config file defines external MCP servers. At startup, `connectMcpServers()` connects to each (skipping failures), producing `UnifiedToolDef[]` for GenericProvider and raw SSE configs for ClaudeProvider's native `mcpServers`. The MCP SDK Client handles SSE transport and tool calls.

**Tech Stack:** `@modelcontextprotocol/sdk` (Client, SSEClientTransport), Zod validation, existing UnifiedToolDef pattern.

---

### Task 1: Install MCP SDK dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the package**

Run: `npm install @modelcontextprotocol/sdk`
Expected: added to dependencies in package.json

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk dependency"
```

---

### Task 2: Create `src/mcp/config.ts` — config loader

**Files:**
- Create: `src/mcp/config.ts`
- Create: `test/mcp/config.test.ts`

**Step 1: Write the failing tests**

```ts
// test/mcp/config.test.ts
import { describe, it, expect } from "vitest";
import { parseMcpConfig, type McpServerConfig } from "../../src/mcp/config.js";

describe("parseMcpConfig", () => {
  it("parses valid config with url only", () => {
    const raw = { github: { url: "http://localhost:3001/sse" } };
    const result = parseMcpConfig(raw);
    expect(result).toEqual({
      github: { url: "http://localhost:3001/sse", headers: {} },
    });
  });

  it("parses config with headers", () => {
    const raw = {
      notion: {
        url: "http://remote:8080/sse",
        headers: { Authorization: "Bearer tok" },
      },
    };
    const result = parseMcpConfig(raw);
    expect(result.notion.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("parses empty config", () => {
    const result = parseMcpConfig({});
    expect(result).toEqual({});
  });

  it("throws on missing url", () => {
    expect(() => parseMcpConfig({ bad: {} } as any)).toThrow();
  });

  it("throws on invalid url type", () => {
    expect(() => parseMcpConfig({ bad: { url: 123 } } as any)).toThrow();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/mcp/config.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/mcp/config.ts
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../logger.js";

const mcpServerSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
});

const mcpConfigSchema = z.record(mcpServerSchema);

export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpConfig = Record<string, McpServerConfig>;

/** Parse and validate raw config object. */
export function parseMcpConfig(raw: unknown): McpConfig {
  return mcpConfigSchema.parse(raw);
}

/**
 * Load MCP server config from `mcp-servers.json` in the given directory.
 * Returns empty config if file does not exist.
 * Throws on malformed JSON or schema validation failure.
 */
export function loadMcpConfig(dir: string): McpConfig {
  const filePath = resolve(dir, "mcp-servers.json");
  if (!existsSync(filePath)) {
    log.info("[mcp] No mcp-servers.json found — no external MCP servers");
    return {};
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  return parseMcpConfig(raw);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mcp/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/mcp/config.ts test/mcp/config.test.ts
git commit -m "feat: add MCP server config loader with Zod validation"
```

---

### Task 3: Create `src/mcp/bridge.ts` — MCP client bridge

**Files:**
- Create: `src/mcp/bridge.ts`
- Create: `test/mcp/bridge.test.ts`

**Step 1: Write the failing tests**

Tests mock the MCP Client to avoid real network calls.

```ts
// test/mcp/bridge.test.ts
import { describe, it, expect, vi } from "vitest";
import { bridgeMcpTools, type McpBridgeResult } from "../../src/mcp/bridge.js";
import type { McpConfig } from "../../src/mcp/config.js";

// We'll test the tool conversion logic by mocking connectAndListTools
vi.mock("../../src/mcp/bridge.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/mcp/bridge.js")>();
  return {
    ...original,
    // Re-export everything, tests call bridgeMcpTools which we test via integration
  };
});

describe("bridgeMcpTools", () => {
  it("returns empty results for empty config", async () => {
    const result = await bridgeMcpTools({});
    expect(result.tools).toEqual([]);
    expect(result.claudeServerConfigs).toEqual({});
    expect(result.connected).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/mcp/bridge.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```ts
// src/mcp/bridge.ts
import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import { log } from "../logger.js";
import type { McpConfig, McpServerConfig } from "./config.js";
import type { UnifiedToolDef } from "../tools/types.js";
import { z } from "zod";

const CONNECT_TIMEOUT_MS = 10_000;

export type McpBridgeResult = {
  /** UnifiedToolDef[] for GenericProvider (bridged tools) */
  tools: UnifiedToolDef[];
  /** SSE configs for ClaudeProvider's native mcpServers */
  claudeServerConfigs: Record<string, { url: string; headers?: Record<string, string> }>;
  /** Successfully connected server names */
  connected: { name: string; toolCount: number }[];
  /** Skipped server names with reasons */
  skipped: { name: string; reason: string }[];
};

/**
 * Connect to all configured MCP servers, list their tools, and produce
 * both UnifiedToolDef[] (for GenericProvider) and native configs (for ClaudeProvider).
 *
 * Servers that fail to connect are skipped with a warning.
 */
export async function bridgeMcpTools(config: McpConfig): Promise<McpBridgeResult> {
  const tools: UnifiedToolDef[] = [];
  const claudeServerConfigs: McpBridgeResult["claudeServerConfigs"] = {};
  const connected: McpBridgeResult["connected"] = [];
  const skipped: McpBridgeResult["skipped"] = [];

  const entries = Object.entries(config);
  if (entries.length === 0) return { tools, claudeServerConfigs, connected, skipped };

  for (const [serverName, serverConfig] of entries) {
    try {
      const { client, serverTools } = await connectAndListTools(serverName, serverConfig);

      // Build UnifiedToolDef for each tool (GenericProvider path)
      for (const mcpTool of serverTools) {
        tools.push(mcpToolToUnified(serverName, mcpTool, client));
      }

      // Store native config for ClaudeProvider path
      claudeServerConfigs[serverName] = {
        url: serverConfig.url,
        ...(Object.keys(serverConfig.headers).length > 0 && { headers: serverConfig.headers }),
      };

      connected.push({ name: serverName, toolCount: serverTools.length });
    } catch (err: any) {
      const reason = err.message ?? String(err);
      skipped.push({ name: serverName, reason });
    }
  }

  return { tools, claudeServerConfigs, connected, skipped };
}

type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema: { type: "object"; properties?: Record<string, object>; required?: string[] };
};

async function connectAndListTools(
  serverName: string,
  config: McpServerConfig,
): Promise<{ client: Client; serverTools: McpToolInfo[] }> {
  const transport = new SSEClientTransport(new URL(config.url), {
    eventSourceInit: {
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...(init?.headers as Record<string, string>), ...config.headers },
        }),
    },
  });

  const client = new Client({ name: "ai-claw", version: "1.0.0" });

  // Connect with timeout
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Connection timeout")), CONNECT_TIMEOUT_MS),
  );
  await Promise.race([connectPromise, timeoutPromise]);

  const result = await client.listTools();
  return { client, serverTools: result.tools as McpToolInfo[] };
}

/**
 * Convert a single MCP tool into a UnifiedToolDef.
 * The execute() function proxies to the MCP client's callTool().
 */
function mcpToolToUnified(serverName: string, mcpTool: McpToolInfo, client: Client): UnifiedToolDef {
  const prefixedName = `${serverName}__${mcpTool.name}`;
  const description = mcpTool.description ?? `${serverName} tool: ${mcpTool.name}`;

  // Build Zod inputSchema from JSON Schema properties
  const zodProps: Record<string, z.ZodType> = {};
  const props = mcpTool.inputSchema?.properties ?? {};
  const required = new Set(mcpTool.inputSchema?.required ?? []);
  for (const [key, _schema] of Object.entries(props)) {
    // Use z.any() as a pass-through — the MCP server validates its own inputs.
    zodProps[key] = required.has(key) ? z.any() : z.any().optional();
  }

  return {
    name: prefixedName,
    description,
    inputSchema: zodProps,
    parameters: mcpTool.inputSchema ?? { type: "object", properties: {} },
    execute: async (args: any) => {
      try {
        const result = await client.callTool({ name: mcpTool.name, arguments: args });
        // Extract text content from MCP result
        const content = (result as any).content;
        if (Array.isArray(content)) {
          return content
            .map((c: any) => {
              if (c.type === "text") return c.text;
              if (c.type === "image") return `[image: ${c.mimeType}]`;
              return JSON.stringify(c);
            })
            .join("\n");
        }
        return JSON.stringify(result);
      } catch (err: any) {
        return `Error: ${err.message}`;
      }
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/mcp/bridge.test.ts`
Expected: PASS (at minimum the empty config test)

**Step 5: Commit**

```bash
git add src/mcp/bridge.ts test/mcp/bridge.test.ts
git commit -m "feat: add MCP client bridge — SSE connect + UnifiedToolDef conversion"
```

---

### Task 4: Wire bridge into `suite.ts` and `setup.ts`

**Files:**
- Modify: `src/tools/suite.ts` — accept extra `UnifiedToolDef[]` param
- Modify: `src/chat/setup.ts` — merge `claudeServerConfigs` into `mcpServers`

**Step 1: Update `buildToolSuite` signature**

In `src/tools/suite.ts`, add optional `extraTools` parameter:

```ts
// Add to buildToolSuite parameters:
export function buildToolSuite(
  env: ToolSuiteEnv,
  skillsDirs: string[],
  memoryManager?: MemoryManager,
  opts?: { subagentManager?: SubagentManager; defaultProvider?: string; extraTools?: UnifiedToolDef[] },
): ToolSuiteResult {
  // ... existing toolDefs assembly ...

  // Append bridged MCP tools
  if (opts?.extraTools) {
    toolDefs.push(...opts.extraTools);
  }

  // ... rest unchanged ...
}
```

**Step 2: Update `setupChatProvider` to merge Claude MCP configs**

In `src/chat/setup.ts`, accept `claudeServerConfigs` and merge:

```ts
export function setupChatProvider(
  env: ChatSetupEnv,
  skillsDirs: string[],
  existingSuite?: ToolSuiteResult,
  memoryManager?: MemoryManager,
  claudeServerConfigs?: Record<string, { url: string; headers?: Record<string, string> }>,
): ChatSetupResult {
  // ... existing code ...

  // Build the registry — merge external MCP configs for ClaudeProvider
  const mergedMcpServers = {
    ...suite.mcpServers,
    ...(claudeServerConfigs ?? {}),
  };

  const registry = buildDefaultRegistry(
    env as unknown as Record<string, string | undefined>,
    {
      systemPrompt,
      skillsDirs,
      mcpServers: mergedMcpServers,
      genericTools: suite.genericTools,
    },
  );

  // ...
  return { provider, registry, mcpServers: mergedMcpServers };
}
```

**Step 3: Run existing tests to check nothing breaks**

Run: `npx vitest run test/tools/suite.test.ts test/chat/provider-registry.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/suite.ts src/chat/setup.ts
git commit -m "feat: wire MCP bridge into tool suite and chat setup"
```

---

### Task 5: Wire into `server.ts` startup

**Files:**
- Modify: `src/server.ts`

**Step 1: Add MCP bridge calls to `createApp()`**

After skills scanning, before tool suite building:

```ts
import { loadMcpConfig } from "./mcp/config.js";
import { bridgeMcpTools } from "./mcp/bridge.js";

// Inside createApp(), after skill eligibility logging:

// --- External MCP Servers ---
const mcpConfig = loadMcpConfig(process.cwd());
const mcpBridge = await bridgeMcpTools(mcpConfig);
for (const s of mcpBridge.connected) {
  log.info(`[init]   + ${s.name} (${s.toolCount} tools)`);
}
for (const s of mcpBridge.skipped) {
  log.warn(`[init]   - ${s.name} (${s.reason} — skipped)`);
}
if (mcpBridge.connected.length > 0 || mcpBridge.skipped.length > 0) {
  log.info(`[init] MCP servers: ${mcpBridge.connected.length} connected, ${mcpBridge.skipped.length} skipped`);
}
```

Note: `createApp()` becomes `async` since `bridgeMcpTools()` is async. Update `startServer()` accordingly.

Pass results into `buildToolSuite` and `setupChatProvider`:

```ts
const toolSuite = buildToolSuite(env, skillsDirs, memoryManager, {
  subagentManager,
  defaultProvider: env.CHAT_PROVIDER,
  extraTools: mcpBridge.tools,
});

const setup = setupChatProvider(env, skillsDirs, toolSuite, memoryManager, mcpBridge.claudeServerConfigs);
```

**Step 2: Verify the app still starts (manual test)**

Run: `npm run build`
Expected: No compile errors

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "feat: wire MCP bridge into server startup with graceful skip"
```

---

### Task 6: Update `.gitignore` and `.env.example`

**Files:**
- Modify: `.gitignore`
- Modify: `.env.example`
- Create: `mcp-servers.example.json`

**Step 1: Add `mcp-servers.json` to `.gitignore`**

Append: `mcp-servers.json`

**Step 2: Add example config file**

```json
{
  "example-server": {
    "url": "http://localhost:3001/sse",
    "headers": {
      "Authorization": "Bearer your-token-here"
    }
  }
}
```

**Step 3: Add comment to `.env.example`**

```
# External MCP Servers (optional — configure in mcp-servers.json)
# See mcp-servers.example.json for format
```

**Step 4: Commit**

```bash
git add .gitignore .env.example mcp-servers.example.json
git commit -m "docs: add MCP server config example and gitignore"
```

---

### Task 7: Integration test with mock MCP server

**Files:**
- Create: `test/mcp/integration.test.ts`

**Step 1: Write integration test using in-process MCP server**

```ts
// test/mcp/integration.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse";
import { createServer, type Server as HttpServer } from "node:http";
import { bridgeMcpTools } from "../../src/mcp/bridge.js";

describe("MCP bridge integration", () => {
  let httpServer: HttpServer;
  let port: number;
  let transport: SSEServerTransport | null = null;

  // Start a real MCP server over SSE for testing
  const mcpServer = new Server({ name: "test-server", version: "1.0.0" }, {
    capabilities: { tools: {} },
  });
  mcpServer.setRequestHandler({ method: "tools/list" } as any, async () => ({
    tools: [
      {
        name: "greet",
        description: "Say hello",
        inputSchema: {
          type: "object" as const,
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    ],
  }));
  mcpServer.setRequestHandler({ method: "tools/call" } as any, async (req: any) => ({
    content: [{ type: "text", text: `Hello, ${req.params.arguments.name}!` }],
  }));

  // Setup HTTP server with SSE transport
  beforeAll(async () => {
    httpServer = createServer(async (req, res) => {
      if (req.url === "/sse") {
        transport = new SSEServerTransport("/messages", res);
        await mcpServer.connect(transport);
      } else if (req.url === "/messages" && req.method === "POST") {
        if (transport) {
          await transport.handlePostMessage(req, res);
        }
      }
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await mcpServer.close();
    httpServer.close();
  });

  it("connects to SSE server and bridges tools", async () => {
    const result = await bridgeMcpTools({
      "test-server": { url: `http://localhost:${port}/sse`, headers: {} },
    });

    expect(result.connected).toHaveLength(1);
    expect(result.connected[0].name).toBe("test-server");
    expect(result.connected[0].toolCount).toBe(1);
    expect(result.skipped).toHaveLength(0);

    // Check UnifiedToolDef
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test-server__greet");
    expect(result.tools[0].description).toBe("Say hello");

    // Check Claude config passthrough
    expect(result.claudeServerConfigs["test-server"]).toEqual({
      url: `http://localhost:${port}/sse`,
    });
  });

  it("executes bridged tool via callTool proxy", async () => {
    const result = await bridgeMcpTools({
      "test-server": { url: `http://localhost:${port}/sse`, headers: {} },
    });

    const greetTool = result.tools[0];
    const output = await greetTool.execute({ name: "World" }, { userId: "", sessionId: "" });
    expect(output).toBe("Hello, World!");
  });

  it("skips unreachable servers gracefully", async () => {
    const result = await bridgeMcpTools({
      "bad-server": { url: "http://localhost:1/sse", headers: {} },
    });

    expect(result.connected).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].name).toBe("bad-server");
    expect(result.tools).toHaveLength(0);
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run test/mcp/integration.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add test/mcp/integration.test.ts
git commit -m "test: add MCP bridge integration test with in-process SSE server"
```
