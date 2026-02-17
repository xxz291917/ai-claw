import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers.js";

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
});
