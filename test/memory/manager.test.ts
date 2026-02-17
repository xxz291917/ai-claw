import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers.js";
import { MemoryManager } from "../../src/memory/manager.js";

describe("MemoryManager", () => {
  describe("schema", () => {
    it("creates memory table and FTS index", () => {
      const db = createTestDb();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory%'")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain("memory");
      expect(names).toContain("memory_fts");
    });
  });

  describe("save + getByUser", () => {
    it("saves memories and retrieves them by user", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [
        { category: "preference", key: "语言", value: "中文" },
        { category: "decision", key: "部署方案", value: "Docker Compose" },
      ], "session-1");

      const items = mgr.getByUser("alice");
      expect(items).toHaveLength(2);
      expect(items[0].key).toBe("语言");
      expect(items[0].userId).toBe("alice");
      expect(items[0].sourceSessionId).toBe("session-1");
    });

    it("upserts on duplicate user_id + category + key", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [
        { category: "preference", key: "语言", value: "中文" },
      ]);
      mgr.save("alice", [
        { category: "preference", key: "语言", value: "English" },
      ]);

      const items = mgr.getByUser("alice");
      expect(items).toHaveLength(1);
      expect(items[0].value).toBe("English");
    });

    it("isolates memories between users", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [{ category: "fact", key: "team", value: "backend" }]);
      mgr.save("bob", [{ category: "fact", key: "team", value: "frontend" }]);

      expect(mgr.getByUser("alice")).toHaveLength(1);
      expect(mgr.getByUser("bob")).toHaveLength(1);
      expect(mgr.getByUser("alice")[0].value).toBe("backend");
    });
  });
});
