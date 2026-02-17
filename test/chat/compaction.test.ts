import { describe, it, expect, vi } from "vitest";
import { compactHistory } from "../../src/chat/compaction.js";

type Msg = { role: "user" | "assistant" | "system"; content: string };

function makeMessages(count: number): Msg[] {
  const msgs: Msg[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    });
  }
  return msgs;
}

describe("compactHistory", () => {
  it("returns history unchanged when under max", async () => {
    const history = makeMessages(10);
    const result = await compactHistory(history, { maxMessages: 40 });
    expect(result).toEqual(history);
  });

  it("truncates with note when over max and no summarizer", async () => {
    const history = makeMessages(50);
    const result = await compactHistory(history, { maxMessages: 20 });

    // Should have: 1 system note + 20 recent messages
    expect(result).toHaveLength(21);
    expect(result[0]).toMatchObject({
      role: "system",
      content: "[Earlier 30 messages omitted]",
    });
    // Last message should be the last from original
    expect(result[20].content).toBe("message 49");
  });

  it("uses summarizer when provided", async () => {
    const history = makeMessages(50);
    const summarize = vi.fn().mockResolvedValue("Summary of early conversation");

    const result = await compactHistory(history, {
      maxMessages: 20,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    // Summarizer receives the early 30 messages
    expect(summarize.mock.calls[0][0]).toHaveLength(30);

    expect(result).toHaveLength(21);
    expect(result[0]).toMatchObject({
      role: "system",
      content: "Previous conversation summary:\nSummary of early conversation",
    });
  });

  it("falls back to truncation when summarizer fails", async () => {
    const history = makeMessages(50);
    const summarize = vi.fn().mockRejectedValue(new Error("API error"));

    const result = await compactHistory(history, {
      maxMessages: 20,
      summarize,
    });

    expect(result).toHaveLength(21);
    expect(result[0]).toMatchObject({
      role: "system",
      content: "[Earlier 30 messages omitted]",
    });
  });

  it("uses default maxMessages of 40", async () => {
    const history = makeMessages(50);
    const result = await compactHistory(history);

    expect(result).toHaveLength(41); // 1 note + 40 recent
  });

  describe("Memory Flush", () => {
    it("calls memoryFlush with early messages before compaction", async () => {
      const history = makeMessages(50);
      const memoryFlush = vi.fn().mockResolvedValue(undefined);

      await compactHistory(history, { maxMessages: 20, memoryFlush });

      expect(memoryFlush).toHaveBeenCalledTimes(1);
      // Should receive the 30 early messages that will be compacted
      expect(memoryFlush.mock.calls[0][0]).toHaveLength(30);
    });

    it("still compacts normally if memoryFlush fails", async () => {
      const history = makeMessages(50);
      const memoryFlush = vi.fn().mockRejectedValue(new Error("flush failed"));

      const result = await compactHistory(history, {
        maxMessages: 20,
        memoryFlush,
      });

      // Should still produce compacted result
      expect(result).toHaveLength(21);
      expect(result[0].role).toBe("system");
    });

    it("does not call memoryFlush when history is under max", async () => {
      const history = makeMessages(10);
      const memoryFlush = vi.fn();

      await compactHistory(history, { maxMessages: 40, memoryFlush });

      expect(memoryFlush).not.toHaveBeenCalled();
    });
  });
});
