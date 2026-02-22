import type Database from "better-sqlite3";
import type { HubEvent } from "./hub-event.js";

export class EventLog {
  constructor(private db: Database.Database) {}

  log(event: HubEvent): void {
    // Merge metadata into payload to preserve receivedAt/traceId without schema change
    const payload = { ...event.payload, _metadata: event.metadata };
    this.db
      .prepare(
        "INSERT INTO event_log (id, type, source, payload, context) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.type,
        event.source,
        JSON.stringify(payload),
        event.context ? JSON.stringify(event.context) : null,
      );
  }
}
