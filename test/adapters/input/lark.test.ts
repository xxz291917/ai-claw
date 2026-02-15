import { describe, it, expect } from "vitest";
import { LarkInputAdapter } from "../../../src/adapters/input/lark.js";

describe("LarkInputAdapter", () => {
  const adapter = new LarkInputAdapter();

  it("converts card action callback to HubEvent", () => {
    const raw = {
      action: { value: { action: "fix", taskId: "t-1" } },
    };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("lark.card_action");
    expect(event!.payload.action).toBe("fix");
    expect(event!.payload.taskId).toBe("t-1");
  });

  it("converts p2p chat message to HubEvent", () => {
    const raw = {
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user1" } },
        message: {
          chat_type: "p2p",
          message_id: "msg-1",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("chat.lark_p2p");
    expect(event!.payload.message).toBe("hello");
    expect(event!.context?.userId).toBe("ou_user1");
  });

  it("converts group @mention message to HubEvent", () => {
    const raw = {
      header: { event_type: "im.message.receive_v1" },
      event: {
        sender: { sender_id: { open_id: "ou_user2" } },
        message: {
          chat_type: "group",
          chat_id: "oc_group1",
          message_id: "msg-2",
          root_id: "msg-root",
          content: JSON.stringify({ text: "@_user_1 help me" }),
        },
      },
    };

    const event = adapter.toEvent(raw);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("chat.lark_group");
    expect(event!.context?.userId).toBe("ou_user2");
    expect(event!.context?.replyTo).toBe("msg-root");
  });

  it("handles challenge verification", () => {
    const raw = { challenge: "abc123" };
    const event = adapter.toEvent(raw);
    expect(event).toBeNull();
  });
});
