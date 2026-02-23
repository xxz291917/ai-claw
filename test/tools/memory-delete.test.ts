import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers.js";
import { MemoryManager } from "../../src/memory/manager.js";
import { createMemoryDeleteTool } from "../../src/tools/memory-delete.js";

describe("memory_delete tool", () => {
  it("deletes a memory by id", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    mgr.save("alice", [{ category: "fact", key: "name", value: "Alice" }]);
    const items = mgr.getByUser("alice");
    const tool = createMemoryDeleteTool(mgr);

    const result = await tool.execute({ id: items[0].id }, { userId: "alice", sessionId: "s1" });
    expect(result).toContain("Deleted memory");
    expect(mgr.getByUser("alice")).toHaveLength(0);
  });

  it("includes reason in result when provided", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    mgr.save("alice", [{ category: "fact", key: "name", value: "Alice" }]);
    const items = mgr.getByUser("alice");
    const tool = createMemoryDeleteTool(mgr);

    const result = await tool.execute({
      id: items[0].id,
      reason: "duplicate of id=99",
    }, { userId: "alice", sessionId: "s1" });
    expect(result).toContain("Deleted memory");
    expect(result).toContain("duplicate of id=99");
  });

  it("rejects deletion of another user's memory", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    mgr.save("alice", [{ category: "fact", key: "secret", value: "private" }]);
    const aliceItems = mgr.getByUser("alice");
    const tool = createMemoryDeleteTool(mgr);

    const result = await tool.execute({ id: aliceItems[0].id }, { userId: "bob", sessionId: "s1" });
    expect(result).toContain("Error");
    expect(result).toContain("not found or does not belong");
    expect(mgr.getByUser("alice")).toHaveLength(1);
  });

  it("returns error for nonexistent id", async () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemoryDeleteTool(mgr);

    const result = await tool.execute({ id: 9999 }, { userId: "alice", sessionId: "s1" });
    expect(result).toContain("Error");
  });

  it("has correct tool metadata", () => {
    const db = createTestDb();
    const mgr = new MemoryManager(db);
    const tool = createMemoryDeleteTool(mgr);

    expect(tool.name).toBe("memory_delete");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters).toHaveProperty("properties.id");
    expect(tool.parameters).toHaveProperty("properties.reason");
  });
});
