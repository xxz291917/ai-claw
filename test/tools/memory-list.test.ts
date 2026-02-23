import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers.js";
import { MemoryManager } from "../../src/memory/manager.js";
import { createMemoryListTool } from "../../src/tools/memory-list.js";

const ctx = (userId: string) => ({ userId, sessionId: "s1" });

describe("memory_list tool", () => {
  it("returns all memories for the user", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    mgr.save("alice", [
      { category: "fact", key: "name", value: "Alice" },
      { category: "preference", key: "editor", value: "VS Code" },
    ]);
    const tool = createMemoryListTool(mgr);

    const result = await tool.execute({}, ctx("alice"));

    expect(result).toContain("Total memories: 2");
    expect(result).toContain("[fact]");
    expect(result).toContain("[preference]");
    expect(result).toContain("name: Alice");
    expect(result).toContain("editor: VS Code");
  });

  it("returns empty message when no memories", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemoryListTool(mgr);

    const result = await tool.execute({}, ctx("alice"));

    expect(result).toContain("No memories found");
  });

  it("filters by category when provided", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    mgr.save("alice", [
      { category: "fact", key: "name", value: "Alice" },
      { category: "preference", key: "editor", value: "VS Code" },
      { category: "todo", key: "deploy", value: "Deploy to prod" },
    ]);
    const tool = createMemoryListTool(mgr);

    const result = await tool.execute({ category: "preference" }, ctx("alice"));

    expect(result).toContain("[preference]");
    expect(result).toContain("editor: VS Code");
    expect(result).not.toContain("[fact]");
    expect(result).not.toContain("[todo]");
    expect(result).toContain("Total memories: 3");
  });

  it("returns message when filtered category is empty", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    mgr.save("alice", [
      { category: "fact", key: "name", value: "Alice" },
    ]);
    const tool = createMemoryListTool(mgr);

    const result = await tool.execute({ category: "todo" }, ctx("alice"));

    expect(result).toContain('No memories found in category "todo"');
    expect(result).toContain("Total memories: 1");
  });

  it("isolates memories by ctx.userId", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    mgr.save("alice", [{ category: "fact", key: "name", value: "Alice" }]);
    mgr.save("bob", [{ category: "fact", key: "name", value: "Bob" }]);

    const tool = createMemoryListTool(mgr);

    const resultAlice = await tool.execute({}, ctx("alice"));
    const resultBob = await tool.execute({}, ctx("bob"));

    expect(resultAlice).toContain("name: Alice");
    expect(resultAlice).not.toContain("name: Bob");
    expect(resultBob).toContain("name: Bob");
    expect(resultBob).not.toContain("name: Alice");
  });

  it("includes memory IDs for cross-referencing with memory_delete", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    mgr.save("alice", [{ category: "fact", key: "name", value: "Alice" }]);
    const items = mgr.getByUser("alice");
    const tool = createMemoryListTool(mgr);

    const result = await tool.execute({}, ctx("alice"));

    expect(result).toContain(`id=${items[0].id}`);
  });

  it("has correct tool metadata", () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemoryListTool(mgr);

    expect(tool.name).toBe("memory_list");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toHaveProperty("properties.category");
  });
});
