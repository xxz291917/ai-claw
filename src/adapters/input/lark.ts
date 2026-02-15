import type { InputAdapter } from "./types.js";
import { createHubEvent, type HubEvent } from "../../core/hub-event.js";

export class LarkInputAdapter implements InputAdapter {
  readonly source = "lark";

  toEvent(raw: unknown): HubEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const body = raw as Record<string, any>;

    // Challenge verification — not an event
    if (body.challenge) return null;

    // Card action callback
    if (body.action?.value?.action) {
      return createHubEvent({
        type: "lark.card_action",
        source: this.source,
        payload: {
          action: body.action.value.action,
          taskId: body.action.value.taskId,
        },
      });
    }

    // Message event
    if (body.header?.event_type === "im.message.receive_v1" && body.event?.message) {
      const msg = body.event.message;
      const senderId = body.event.sender?.sender_id?.open_id ?? "";
      const chatType = msg.chat_type;

      let text = "";
      try {
        const content = JSON.parse(msg.content ?? "{}");
        text = content.text ?? "";
      } catch {
        text = "";
      }

      const type = chatType === "p2p" ? "chat.lark_p2p" : "chat.lark_group";

      return createHubEvent({
        type,
        source: this.source,
        payload: {
          message: text,
          messageId: msg.message_id,
          chatId: msg.chat_id,
        },
        context: {
          userId: senderId,
          replyTo: msg.root_id,
        },
      });
    }

    return null;
  }
}
