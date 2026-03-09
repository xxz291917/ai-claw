import { describe, it, expect } from "vitest";
import { computeNextRunAt, describeSchedule } from "../../src/cron/schedule.js";

describe("computeNextRunAt", () => {
  const NOW = new Date("2026-03-09T12:00:00Z").getTime();

  describe("at schedule", () => {
    it("returns the time if in the future", () => {
      const at = "2026-03-10T09:00:00Z";
      const result = computeNextRunAt({ kind: "at", at }, NOW);
      expect(result).toBe(new Date(at).getTime());
    });

    it("returns null if in the past", () => {
      const at = "2026-03-08T09:00:00Z";
      expect(computeNextRunAt({ kind: "at", at }, NOW)).toBeNull();
    });
  });

  describe("every schedule", () => {
    it("returns now + everyMs without anchor", () => {
      const result = computeNextRunAt({ kind: "every", everyMs: 60_000 }, NOW);
      expect(result).toBe(NOW + 60_000);
    });

    it("aligns to anchor", () => {
      const anchor = NOW - 150_000; // 2.5 intervals ago (at 60s intervals)
      const result = computeNextRunAt({ kind: "every", everyMs: 60_000, anchorMs: anchor }, NOW);
      // Should be anchor + 3 * 60000 = anchor + 180000
      expect(result).toBe(anchor + 180_000);
      expect(result!).toBeGreaterThan(NOW);
    });

    it("returns null for non-positive interval", () => {
      expect(computeNextRunAt({ kind: "every", everyMs: 0 }, NOW)).toBeNull();
      expect(computeNextRunAt({ kind: "every", everyMs: -1 }, NOW)).toBeNull();
    });
  });

  describe("cron schedule", () => {
    it("computes next run for a cron expression", () => {
      // Every day at 9:00 UTC
      const result = computeNextRunAt({ kind: "cron", expr: "0 9 * * *" }, NOW);
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(NOW);
    });

    it("returns null for invalid expression", () => {
      expect(computeNextRunAt({ kind: "cron", expr: "invalid" }, NOW)).toBeNull();
    });
  });
});

describe("describeSchedule", () => {
  it("describes at schedule", () => {
    expect(describeSchedule({ kind: "at", at: "2026-03-10T09:00:00Z" }))
      .toBe("once at 2026-03-10T09:00:00Z");
  });

  it("describes every schedule in seconds", () => {
    expect(describeSchedule({ kind: "every", everyMs: 30_000 })).toBe("every 30s");
  });

  it("describes every schedule in minutes", () => {
    expect(describeSchedule({ kind: "every", everyMs: 300_000 })).toBe("every 5m");
  });

  it("describes every schedule in hours", () => {
    expect(describeSchedule({ kind: "every", everyMs: 7_200_000 })).toBe("every 2h");
  });

  it("describes cron schedule", () => {
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * *" }))
      .toBe('cron "0 9 * * *"');
  });

  it("describes cron schedule with timezone", () => {
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" }))
      .toBe('cron "0 9 * * *" (Asia/Shanghai)');
  });
});
