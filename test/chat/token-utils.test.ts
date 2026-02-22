import { describe, it, expect } from "vitest";
import {
  estimateStringTokens,
  estimateHistoryTokens,
} from "../../src/chat/token-utils.js";

describe("estimateStringTokens", () => {
  it("estimates ASCII text at ~0.25 tokens per char", () => {
    // 8 chars → ceil(8 * 0.25) = 2
    expect(estimateStringTokens("abcdefgh")).toBe(2);
  });

  it("estimates CJK characters at 1 token each", () => {
    // 4 CJK chars → 4 tokens
    expect(estimateStringTokens("你好世界")).toBe(4);
  });

  it("handles mixed CJK and ASCII", () => {
    // "hello" = 5 * 0.25 = 1.25, "你好" = 2, total = ceil(3.25) = 4
    expect(estimateStringTokens("hello你好")).toBe(4);
  });

  it("returns 0 for empty string", () => {
    expect(estimateStringTokens("")).toBe(0);
  });

  it("counts fullwidth forms as CJK", () => {
    // Fullwidth "Ａ" (U+FF21) → 1 token each
    expect(estimateStringTokens("ＡＢ")).toBe(2);
  });

  it("counts CJK punctuation as CJK", () => {
    // "。" (U+3002) → 1 token
    expect(estimateStringTokens("。")).toBe(1);
  });
});

describe("estimateHistoryTokens", () => {
  it("sums tokens across messages", () => {
    const messages = [
      { content: "你好" },    // 2
      { content: "abcdefgh" }, // 2
    ];
    expect(estimateHistoryTokens(messages)).toBe(4);
  });

  it("returns 0 for empty array", () => {
    expect(estimateHistoryTokens([])).toBe(0);
  });
});
