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

// Dynamic keep ratio based on pressure = max(msgs/max, tokens/maxTokens):
//   pressure ≤ 1.5 → keep 75%   (gentle)
//   pressure ≤ 2.0 → keep 50%   (medium)
//   pressure > 2.0 → keep 25%   (aggressive)
//
// 50 msgs, maxMessages=20 → pressure=2.5 → keep=floor(20*0.25)=5
// 50 msgs, maxMessages=40 → pressure=1.25 → keep=floor(40*0.75)=30

describe("compactHistory", () => {
  it("returns history unchanged when under max", async () => {
    const history = makeMessages(10);
    const result = await compactHistory(history, { maxMessages: 40 });
    expect(result).toEqual(history);
  });

  it("truncates with note when over max and no summarizer", async () => {
    const history = makeMessages(50);
    const result = await compactHistory(history, { maxMessages: 20 });

    // pressure=2.5 → keep=25% → floor(20*0.25)=5, 1 note + 5 recent = 6
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({
      role: "system",
      content: "[Earlier 45 messages omitted]",
    });
    // Last message should be the last from original
    expect(result[5].content).toBe("message 49");
  });

  it("uses summarizer when provided", async () => {
    const history = makeMessages(50);
    const summarize = vi.fn().mockResolvedValue("Summary of early conversation");

    const result = await compactHistory(history, {
      maxMessages: 20,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    // pressure=2.5 → keep=5, summarizer receives 45 early messages
    expect(summarize.mock.calls[0][0]).toHaveLength(45);

    // 1 summary + 5 recent = 6
    expect(result).toHaveLength(6);
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

    // pressure=2.5 → keep=5
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({
      role: "system",
      content: "[Earlier 45 messages omitted]",
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
      // pressure=2.5 → keep=5, flush receives 45 early messages
      expect(memoryFlush.mock.calls[0][0]).toHaveLength(45);
    });

    it("still compacts normally if memoryFlush fails", async () => {
      const history = makeMessages(50);
      const memoryFlush = vi.fn().mockRejectedValue(new Error("flush failed"));

      const result = await compactHistory(history, {
        maxMessages: 20,
        memoryFlush,
      });

      // pressure=2.5 → keep=5, 1 note + 5 recent = 6
      expect(result).toHaveLength(6);
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
      // msgPressure = 35/40 = 0.875 (under threshold)
      // tokenPressure ≈ 8750/500 = 17.5 (way over)
      // pressure = 17.5 → keepRatio = 0.25 → keep = floor(40*0.25) = 10
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

      // 1 system note + 10 kept = 11
      expect(result).toHaveLength(11);
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
