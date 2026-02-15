import type { HubEvent } from "../../core/hub-event.js";

export interface InputAdapter {
  readonly source: string;
  toEvent(raw: unknown): HubEvent | null;
}
