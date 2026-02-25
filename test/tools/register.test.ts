import { describe, it, expect } from "vitest";
import { toolRequestContext } from "../../src/tools/request-context.js";
import { createMcpHandler } from "../../src/tools/register.js";
import type { UnifiedToolDef } from "../../src/tools/types.js";

function makeDef(onExecute: (ctx: any) => void): UnifiedToolDef {
  return {
    name: "test_tool",
    description: "Test tool",
    inputSchema: {},
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      onExecute(ctx);
      return "ok";
    },
  };
}

describe("createMcpHandler", () => {
  it("uses ToolContext from AsyncLocalStorage when set", async () => {
    let capturedCtx: any;
    const handler = createMcpHandler(makeDef((ctx) => (capturedCtx = ctx)));

    await toolRequestContext.run({ userId: "alice", sessionId: "sess-1" }, async () => {
      await handler({});
    });

    expect(capturedCtx.userId).toBe("alice");
    expect(capturedCtx.sessionId).toBe("sess-1");
  });

  it("falls back to empty context when AsyncLocalStorage has no store", async () => {
    let capturedCtx: any;
    const handler = createMcpHandler(makeDef((ctx) => (capturedCtx = ctx)));

    // Explicitly run with undefined store to simulate no context
    await toolRequestContext.run(undefined as any, async () => {
      await handler({});
    });

    expect(capturedCtx.userId).toBe("");
    expect(capturedCtx.sessionId).toBe("");
  });

  it("isolates concurrent invocations via separate run() contexts", async () => {
    const results: string[] = [];

    const handler = createMcpHandler(
      makeDef((ctx) => results.push(ctx.userId))
    );

    await Promise.all([
      toolRequestContext.run({ userId: "alice", sessionId: "s1" }, () => handler({})),
      toolRequestContext.run({ userId: "bob", sessionId: "s2" }, () => handler({})),
    ]);

    expect(results).toHaveLength(2);
    expect(results).toContain("alice");
    expect(results).toContain("bob");
  });

  it("returns isError flag for Error: prefix responses", async () => {
    const def: UnifiedToolDef = {
      name: "err_tool",
      description: "Fails",
      inputSchema: {},
      parameters: { type: "object", properties: {} },
      execute: async () => "Error: something went wrong",
    };
    const handler = createMcpHandler(def);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Error: something went wrong");
  });
});
