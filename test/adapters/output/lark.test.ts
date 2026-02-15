// test/adapters/output/lark.test.ts
import { describe, it, expect, vi } from "vitest";
import { LarkOutputAdapter } from "../../../src/adapters/output/lark.js";

describe("LarkOutputAdapter", () => {
  it("supports notify action with channel lark", () => {
    const adapter = new LarkOutputAdapter({ sendCard: vi.fn() });
    expect(adapter.supports({ type: "notify", channel: "lark", card: {} })).toBe(true);
  });

  it("does not support create_pr action", () => {
    const adapter = new LarkOutputAdapter({ sendCard: vi.fn() });
    expect(
      adapter.supports({ type: "create_pr", repo: "", branch: "", title: "", body: "" }),
    ).toBe(false);
  });

  it("does not support notify with non-lark channel", () => {
    const adapter = new LarkOutputAdapter({ sendCard: vi.fn() });
    expect(adapter.supports({ type: "notify", channel: "slack", card: {} })).toBe(false);
  });

  it("calls sendCard on notify action", async () => {
    const sendCard = vi.fn().mockResolvedValue("msg-1");
    const adapter = new LarkOutputAdapter({ sendCard });

    await adapter.send({ type: "notify", channel: "lark", card: { header: {} } });

    expect(sendCard).toHaveBeenCalledWith({ header: {} });
  });
});
