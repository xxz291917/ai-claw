type HistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type SummarizeFn = (
  messages: HistoryMessage[],
) => Promise<string>;

export type CompactOptions = {
  maxMessages?: number;
  summarize?: SummarizeFn;
};

const DEFAULT_MAX_MESSAGES = 40;

export async function compactHistory(
  history: HistoryMessage[],
  opts: CompactOptions = {},
): Promise<HistoryMessage[]> {
  const max = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;

  if (history.length <= max) return history;

  const cutoff = history.length - max;
  const early = history.slice(0, cutoff);
  const recent = history.slice(cutoff);

  if (opts.summarize) {
    try {
      const summary = await opts.summarize(early);
      return [
        { role: "system", content: `Previous conversation summary:\n${summary}` },
        ...recent,
      ];
    } catch {
      // Fallback to simple truncation on summarization failure
    }
  }

  return [
    { role: "system", content: `[Earlier ${early.length} messages omitted]` },
    ...recent,
  ];
}
