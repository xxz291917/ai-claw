import type Database from "better-sqlite3";
import type { HubEvent } from "./hub-event.js";

type Handler = (event: HubEvent) => Promise<void> | void;

export class EventBus {
  private handlers: Array<{ pattern: string; handler: Handler }> = [];

  constructor(private db: Database.Database) {}

  on(pattern: string, handler: Handler): void {
    this.handlers.push({ pattern, handler });
  }

  async emit(event: HubEvent): Promise<void> {
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

    for (const { pattern, handler } of this.handlers) {
      if (this.matches(pattern, event.type)) {
        await handler(event);
      }
    }
  }

  private matches(pattern: string, type: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) {
      return type.startsWith(pattern.slice(0, -1));
    }
    return pattern === type;
  }
}
