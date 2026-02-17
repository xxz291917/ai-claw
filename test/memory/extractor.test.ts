import { describe, it, expect, vi } from "vitest";
import { extractMemories } from "../../src/memory/extractor.js";

type Msg = { role: "user" | "assistant" | "system"; content: string };

const sampleMessages: Msg[] = [
  { role: "user", content: "我们用 Docker Compose 部署吧" },
  { role: "assistant", content: "好的，我来写 docker-compose.yml" },
  { role: "user", content: "记得我喜欢用中文回答" },
  { role: "assistant", content: "了解，后续都用中文回复你" },
];

describe("extractMemories", () => {
  it("extracts structured memories from LLM response", async () => {
    const llmResponse = JSON.stringify([
      { category: "decision", key: "部署方案", value: "使用 Docker Compose" },
      { category: "preference", key: "回复语言", value: "中文" },
    ]);

    const callLlm = vi.fn().mockResolvedValue(llmResponse);
    const result = await extractMemories(sampleMessages, callLlm);

    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      category: "decision",
      key: "部署方案",
      value: "使用 Docker Compose",
    });
  });

  it("returns empty array when LLM returns []", async () => {
    const callLlm = vi.fn().mockResolvedValue("[]");
    const result = await extractMemories(sampleMessages, callLlm);
    expect(result).toEqual([]);
  });

  it("returns empty array on invalid JSON", async () => {
    const callLlm = vi.fn().mockResolvedValue("not json at all");
    const result = await extractMemories(sampleMessages, callLlm);
    expect(result).toEqual([]);
  });

  it("returns empty array when LLM call fails", async () => {
    const callLlm = vi.fn().mockRejectedValue(new Error("API error"));
    const result = await extractMemories(sampleMessages, callLlm);
    expect(result).toEqual([]);
  });

  it("filters out items with invalid category", async () => {
    const llmResponse = JSON.stringify([
      { category: "decision", key: "ok", value: "valid" },
      { category: "invalid_cat", key: "bad", value: "should be dropped" },
    ]);
    const callLlm = vi.fn().mockResolvedValue(llmResponse);
    const result = await extractMemories(sampleMessages, callLlm);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("ok");
  });

  it("handles LLM response wrapped in markdown code block", async () => {
    const llmResponse = '```json\n[{"category":"fact","key":"lang","value":"TS"}]\n```';
    const callLlm = vi.fn().mockResolvedValue(llmResponse);
    const result = await extractMemories(sampleMessages, callLlm);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("lang");
  });
});
