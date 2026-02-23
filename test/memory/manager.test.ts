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

  describe("search", () => {
    it("finds memories matching query via FTS5", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [
        { category: "decision", key: "部署方案", value: "使用 Docker Compose 部署到生产环境" },
        { category: "preference", key: "编辑器", value: "VS Code 搭配 Vim 插件" },
        { category: "fact", key: "项目语言", value: "TypeScript 和 Python" },
      ]);

      const results = mgr.search("alice", "Docker 部署");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].key).toBe("部署方案");
    });

    it("returns empty array when no match", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [
        { category: "fact", key: "team", value: "backend" },
      ]);

      const results = mgr.search("alice", "xyznonexistent");
      expect(results).toHaveLength(0);
    });

    it("respects limit parameter", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [
        { category: "fact", key: "fact 1", value: "TypeScript project" },
        { category: "fact", key: "fact 2", value: "TypeScript codebase" },
        { category: "fact", key: "fact 3", value: "TypeScript monorepo" },
      ]);

      const results = mgr.search("alice", "TypeScript", 2);
      expect(results).toHaveLength(2);
    });

    it("does not return other users' memories", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [{ category: "fact", key: "secret", value: "alice data" }]);
      mgr.save("bob", [{ category: "fact", key: "secret", value: "bob data" }]);

      const results = mgr.search("alice", "data");
      expect(results).toHaveLength(1);
      expect(results[0].value).toBe("alice data");
    });
  });

  describe("remove", () => {
    it("deletes a memory by id", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [{ category: "fact", key: "temp", value: "to delete" }]);
      const items = mgr.getByUser("alice");
      expect(items).toHaveLength(1);

      mgr.remove(items[0].id);
      expect(mgr.getByUser("alice")).toHaveLength(0);
    });

    it("also removes from FTS index", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);

      mgr.save("alice", [{ category: "fact", key: "temp", value: "searchable content" }]);
      const items = mgr.getByUser("alice");
      mgr.remove(items[0].id);

      const results = mgr.search("alice", "searchable");
      expect(results).toHaveLength(0);
    });
  });

  describe("removeByUser", () => {
    it("deletes memory when userId matches", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);
      mgr.save("alice", [{ category: "fact", key: "name", value: "Alice" }]);
      const items = mgr.getByUser("alice");

      const ok = mgr.removeByUser(items[0].id, "alice");
      expect(ok).toBe(true);
      expect(mgr.getByUser("alice")).toHaveLength(0);
    });

    it("refuses to delete when userId does not match", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);
      mgr.save("alice", [{ category: "fact", key: "name", value: "Alice" }]);
      const items = mgr.getByUser("alice");

      const ok = mgr.removeByUser(items[0].id, "bob");
      expect(ok).toBe(false);
      expect(mgr.getByUser("alice")).toHaveLength(1);
    });

    it("returns false for nonexistent id", () => {
      const db = createTestDb();
      const mgr = new MemoryManager(db);
      expect(mgr.removeByUser(9999, "alice")).toBe(false);
    });
  });
});
