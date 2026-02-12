import Database from "better-sqlite3";
import { initDb } from "../src/db.js";

export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  initDb(db);
  return db;
}
