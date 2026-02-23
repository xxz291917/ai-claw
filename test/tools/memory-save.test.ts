import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers.js";
import { MemoryManager } from "../../src/memory/manager.js";
import { createMemorySaveTool } from "../../src/tools/memory-save.js";

describe("memory_save tool", () => {
  it("saves a memory via handler", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemorySaveTool(mgr, "alice", "session-1");

    const result = await tool.handler({
      category: "preference",
      key: "language",
      value: "中文",
    });

    expect(result).toContain("Saved to memory");
    expect(result).toContain("preference");
    expect(result).toContain("language");

    const items = mgr.getByUser("alice");
    expect(items).toHaveLength(1);
    expect(items[0].category).toBe("preference");
    expect(items[0].key).toBe("language");
    expect(items[0].value).toBe("中文");
    expect(items[0].sourceSessionId).toBe("session-1");
  });

  it("rejects invalid category", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemorySaveTool(mgr, "alice", "session-1");

    const result = await tool.handler({
      category: "invalid",
      key: "test",
      value: "test",
    });

    expect(result).toContain("Error");
    expect(result).toContain("invalid category");
    expect(mgr.getByUser("alice")).toHaveLength(0);
  });

  it("rejects empty key or value", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemorySaveTool(mgr, "alice", "session-1");

    const result = await tool.handler({
      category: "fact",
      key: "",
      value: "test",
    });
    expect(result).toContain("Error");
    expect(mgr.getByUser("alice")).toHaveLength(0);
  });

  it("upserts on same category + key", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemorySaveTool(mgr, "alice", "session-1");

    await tool.handler({ category: "fact", key: "name", value: "Alice" });
    await tool.handler({ category: "fact", key: "name", value: "Alice Wang" });

    const items = mgr.getByUser("alice");
    expect(items).toHaveLength(1);
    expect(items[0].value).toBe("Alice Wang");
  });

  it("isolates memories by userId closure", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const toolAlice = createMemorySaveTool(mgr, "alice", "s1");
    const toolBob = createMemorySaveTool(mgr, "bob", "s2");

    await toolAlice.handler({ category: "fact", key: "team", value: "backend" });
    await toolBob.handler({ category: "fact", key: "team", value: "frontend" });

    expect(mgr.getByUser("alice")).toHaveLength(1);
    expect(mgr.getByUser("bob")).toHaveLength(1);
    expect(mgr.getByUser("alice")[0].value).toBe("backend");
    expect(mgr.getByUser("bob")[0].value).toBe("frontend");
  });

  it("has correct tool metadata", () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemorySaveTool(mgr, "alice", "session-1");

    expect(tool.name).toBe("memory_save");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toHaveProperty("properties.category");
    expect(tool.parameters).toHaveProperty("properties.key");
    expect(tool.parameters).toHaveProperty("properties.value");
  });

  it("returns similar memory hints when duplicates exist", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);

    // Pre-populate with an existing memory using a different key
    mgr.save("alice", [{ category: "fact", key: "姓名", value: "Alice" }]);

    const tool = createMemorySaveTool(mgr, "alice", "session-1");

    // Save with a different key but semantically similar content
    const result = await tool.handler({
      category: "fact",
      key: "name",
      value: "Alice",
    });

    expect(result).toContain("Saved to memory");
    expect(result).toContain("similar existing memories");
    expect(result).toContain("姓名");
    // Both memories exist — dedup is the LLM's decision via memory_delete
    expect(mgr.getByUser("alice")).toHaveLength(2);
  });

  it("does not show hints when no similar memories exist", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemorySaveTool(mgr, "alice", "session-1");

    const result = await tool.handler({
      category: "preference",
      key: "editor",
      value: "VS Code",
    });

    expect(result).toContain("Saved to memory");
    expect(result).not.toContain("similar existing memories");
  });

  it("excludes exact category+key match from hints", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);

    // Pre-populate with exact same category+key (upsert target)
    mgr.save("alice", [{ category: "fact", key: "name", value: "Old Name" }]);

    const tool = createMemorySaveTool(mgr, "alice", "session-1");

    const result = await tool.handler({
      category: "fact",
      key: "name",
      value: "New Name",
    });

    // Should NOT show hints — the exact match was handled by upsert
    expect(result).not.toContain("similar existing memories");
    // Should have been upserted
    expect(mgr.getByUser("alice")).toHaveLength(1);
    expect(mgr.getByUser("alice")[0].value).toBe("New Name");
  });
});
