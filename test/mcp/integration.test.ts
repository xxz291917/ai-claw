import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, type Server as HttpServer } from "node:http";
import { bridgeMcpTools } from "../../src/mcp/bridge.js";

/**
 * Create a fresh MCP Server with the "greet" tool registered.
 * Each SSE connection needs its own Server instance because the SDK
 * does not support multiple concurrent transports on one Server.
 */
function createMcpServer(): Server {
  const s = new Server(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "greet",
        description: "Greets someone by name",
        inputSchema: {
          type: "object" as const,
          properties: { name: { type: "string", description: "Name to greet" } },
          required: ["name"],
        },
      },
    ],
  }));

  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "greet") {
      const args = request.params.arguments as { name: string };
      return {
        content: [{ type: "text", text: `Hello, ${args.name}!` }],
      };
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  });

  return s;
}

describe("MCP bridge integration", () => {
  let httpServer: HttpServer;
  let port: number;
  const servers: Server[] = [];
  const transports = new Map<string, SSEServerTransport>();

  beforeAll(async () => {
    httpServer = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost`);

      if (url.pathname === "/sse") {
        const mcpServer = createMcpServer();
        servers.push(mcpServer);
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        await mcpServer.connect(transport);
      } else if (url.pathname === "/messages" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId");
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(404);
          res.end("No transport found");
        }
      } else {
        res.writeHead(404);
        res.end();
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
    for (const s of servers) {
      await s.close().catch(() => {});
    }
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("connects to SSE server and bridges tools", async () => {
    const result = await bridgeMcpTools({
      "test-server": { url: `http://localhost:${port}/sse`, headers: {} },
    });
    expect(result.connected).toHaveLength(1);
    expect(result.connected[0].name).toBe("test-server");
    expect(result.connected[0].toolCount).toBe(1);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test-server__greet");
    expect(result.claudeServerConfigs["test-server"]).toEqual({
      url: `http://localhost:${port}/sse`,
    });
  });

  it("executes bridged tool via callTool proxy", async () => {
    const result = await bridgeMcpTools({
      "test-server": { url: `http://localhost:${port}/sse`, headers: {} },
    });
    const output = await result.tools[0].execute(
      { name: "World" },
      { userId: "", sessionId: "" },
    );
    expect(output).toBe("Hello, World!");
  });

  it("skips unreachable servers gracefully", async () => {
    const result = await bridgeMcpTools({
      "bad-server": { url: "http://localhost:1/sse", headers: {} },
    });
    expect(result.connected).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].name).toBe("bad-server");
  });
});
