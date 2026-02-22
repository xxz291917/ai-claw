import { describe, it, expect, vi } from "vitest";
import { compactHistory, SUMMARY_PREFIX } from "../../src/chat/compaction.js";

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

// keep = floor(max * 0.75) to leave headroom before next compaction
// maxMessages=20 → keep=15, maxMessages=40 → keep=30

describe("compactHistory", () => {
  it("returns history unchanged when under max", async () => {
    const history = makeMessages(10);
    const result = await compactHistory(history, { maxMessages: 40 });
    expect(result).toEqual(history);
  });

  it("truncates with note when over max and no summarizer", async () => {
    const history = makeMessages(50);
    const result = await compactHistory(history, { maxMessages: 20 });

    // keep=15, so 1 system note + 15 recent = 16
    expect(result).toHaveLength(16);
    expect(result[0]).toMatchObject({
      role: "system",
      content: "[Earlier 35 messages omitted]",
    });
    // Last message should be the last from original
    expect(result[15].content).toBe("message 49");
  });

  it("uses summarizer when provided", async () => {
    const history = makeMessages(50);
    const summarize = vi.fn().mockResolvedValue("Summary of early conversation");

    const result = await compactHistory(history, {
      maxMessages: 20,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    // Summarizer receives the 35 early messages (50 - keep=15)
    expect(summarize.mock.calls[0][0]).toHaveLength(35);

    // 1 summary + 15 recent = 16
    expect(result).toHaveLength(16);
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

    expect(result).toHaveLength(16);
    expect(result[0]).toMatchObject({
      role: "system",
      content: "[Earlier 35 messages omitted]",
    });
  });

  it("uses default maxMessages of 40", async () => {
    const history = makeMessages(50);
    const result = await compactHistory(history);

    // keep=30, so 1 note + 30 recent = 31
    expect(result).toHaveLength(31);
  });

  describe("Memory Flush", () => {
    it("calls memoryFlush with early messages before compaction", async () => {
      const history = makeMessages(50);
      const memoryFlush = vi.fn().mockResolvedValue(undefined);

      await compactHistory(history, { maxMessages: 20, memoryFlush });

      expect(memoryFlush).toHaveBeenCalledTimes(1);
      // Should receive the 35 early messages (50 - keep=15)
      expect(memoryFlush.mock.calls[0][0]).toHaveLength(35);
    });

    it("still compacts normally if memoryFlush fails", async () => {
      const history = makeMessages(50);
      const memoryFlush = vi.fn().mockRejectedValue(new Error("flush failed"));

      const result = await compactHistory(history, {
        maxMessages: 20,
        memoryFlush,
      });

      // Should still produce compacted result: 1 note + 15 recent = 16
      expect(result).toHaveLength(16);
      expect(result[0].role).toBe("system");
    });

    it("does not call memoryFlush when history is under max", async () => {
      const history = makeMessages(10);
      const memoryFlush = vi.fn();

      await compactHistory(history, { maxMessages: 40, memoryFlush });

      expect(memoryFlush).not.toHaveBeenCalled();
    });

    it("skips summary message when flushing to memory", async () => {
      // Simulate history where first message is an existing summary
      const summary: Msg = {
        role: "system",
        content: `${SUMMARY_PREFIX}Earlier conversation about X`,
      };
      const msgs = makeMessages(50);
      const history = [summary, ...msgs]; // 51 total
      const memoryFlush = vi.fn().mockResolvedValue(undefined);

      await compactHistory(history, { maxMessages: 20, memoryFlush });

      expect(memoryFlush).toHaveBeenCalledTimes(1);
      // Should NOT include the summary message in flush
      const flushed = memoryFlush.mock.calls[0][0];
      expect(flushed.every((m: Msg) => !m.content.startsWith(SUMMARY_PREFIX))).toBe(true);
    });
  });

  describe("Incremental Summary Merge", () => {
    it("merges existing summary with new messages", async () => {
      const summary: Msg = {
        role: "system",
        content: `${SUMMARY_PREFIX}User discussed topic A`,
      };
      const msgs = makeMessages(50);
      const history = [summary, ...msgs]; // 51 total

      const summarize = vi.fn().mockResolvedValue("Merged summary of A + new");

      const result = await compactHistory(history, {
        maxMessages: 20,
        summarize,
      });

      expect(summarize).toHaveBeenCalledTimes(1);
      // Should receive a single merge-instruction message
      const callArgs = summarize.mock.calls[0][0];
      expect(callArgs).toHaveLength(1);
      expect(callArgs[0].content).toContain("[MERGE TASK]");
      expect(callArgs[0].content).toContain("User discussed topic A");

      expect(result[0]).toMatchObject({
        role: "system",
        content: `${SUMMARY_PREFIX}Merged summary of A + new`,
      });
    });

    it("does fresh summary when first message is not a summary", async () => {
      const history = makeMessages(50);
      const summarize = vi.fn().mockResolvedValue("Fresh summary");

      const result = await compactHistory(history, {
        maxMessages: 20,
        summarize,
      });

      expect(summarize).toHaveBeenCalledTimes(1);
      // Should receive the raw early messages (not a merge instruction)
      const callArgs = summarize.mock.calls[0][0];
      expect(callArgs.length).toBeGreaterThan(1);
      expect(callArgs[0].content).not.toContain("[MERGE TASK]");

      expect(result[0].content).toBe(`${SUMMARY_PREFIX}Fresh summary`);
    });
  });

  describe("Parallel Execution", () => {
    it("runs memoryFlush and summarize concurrently", async () => {
      const history = makeMessages(50);
      const timeline: string[] = [];

      const memoryFlush = vi.fn().mockImplementation(async () => {
        timeline.push("flush-start");
        await new Promise((r) => setTimeout(r, 50));
        timeline.push("flush-end");
      });

      const summarize = vi.fn().mockImplementation(async () => {
        timeline.push("summarize-start");
        await new Promise((r) => setTimeout(r, 50));
        timeline.push("summarize-end");
        return "Summary";
      });

      await compactHistory(history, {
        maxMessages: 20,
        summarize,
        memoryFlush,
      });

      // Both should start before either finishes
      expect(timeline.indexOf("flush-start")).toBeLessThan(timeline.indexOf("flush-end"));
      expect(timeline.indexOf("summarize-start")).toBeLessThan(timeline.indexOf("summarize-end"));
      // Both starts should happen before either end
      const firstEnd = Math.min(
        timeline.indexOf("flush-end"),
        timeline.indexOf("summarize-end"),
      );
      expect(timeline.indexOf("flush-start")).toBeLessThan(firstEnd);
      expect(timeline.indexOf("summarize-start")).toBeLessThan(firstEnd);
    });
  });

  describe("Token-based Trigger", () => {
    it("triggers compaction when token budget exceeded even if under message count", async () => {
      // 35 messages with long content → lots of tokens
      // maxMessages=40 → not triggered (35 <= 40)
      // keep = floor(40 * 0.75) = 30, cutoff = 35 - 30 = 5
      const history: Msg[] = [];
      for (let i = 0; i < 35; i++) {
        history.push({
          role: i % 2 === 0 ? "user" : "assistant",
          content: "x".repeat(1000), // ~250 tokens each → ~8750 total
        });
      }

      const result = await compactHistory(history, {
        maxMessages: 40,  // won't trigger on count (35 <= 40)
        maxTokens: 500,   // will trigger on tokens (~8750 >> 500)
      });

      // 1 system note + 30 kept = 31 < 35
      expect(result).toHaveLength(31);
      expect(result[0].role).toBe("system");
    });

    it("does not trigger when maxTokens is 0 (disabled)", async () => {
      const history = makeMessages(10);
      const result = await compactHistory(history, {
        maxMessages: 100,
        maxTokens: 0,
      });
      expect(result).toEqual(history);
    });

    it("does not trigger when under both thresholds", async () => {
      const history = makeMessages(10);
      const result = await compactHistory(history, {
        maxMessages: 100,
        maxTokens: 100000,
      });
      expect(result).toEqual(history);
    });
  });
});
