import type Database from "better-sqlite3";
import type { HubEvent } from "./hub-event.js";

export class EventLog {
  constructor(private db: Database.Database) {}

  log(event: HubEvent): void {
    this.db
      .prepare(
        "INSERT INTO event_log (id, type, source, payload, context) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.type,
        event.source,
        JSON.stringify(event.payload),
        event.context ? JSON.stringify(event.context) : null,
      );
  }
}
