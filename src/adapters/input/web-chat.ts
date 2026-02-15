import type { InputAdapter } from "./types.js";
import { createHubEvent, type HubEvent } from "../../core/hub-event.js";

export class WebChatInputAdapter implements InputAdapter {
  readonly source = "web_chat";

  toEvent(raw: unknown): HubEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const body = raw as Record<string, any>;

    if (!body.message || typeof body.message !== "string") return null;

    return createHubEvent({
      type: "chat.web",
      source: this.source,
      payload: { message: body.message },
      context: {
        sessionId: body.sessionId,
      },
    });
  }
}
