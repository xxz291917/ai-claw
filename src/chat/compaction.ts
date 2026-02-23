import { estimateHistoryTokens } from "./token-utils.js";

type HistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  type?: "message" | "summary";
};

export type SummarizeFn = (
  messages: HistoryMessage[],
) => Promise<string>;

export type MemoryFlushFn = (
  messages: HistoryMessage[],
) => Promise<void>;

export type CompactOptions = {
  maxMessages?: number;
  /** Max estimated tokens before triggering compaction. 0 = disabled. */
  maxTokens?: number;
  summarize?: SummarizeFn;
  memoryFlush?: MemoryFlushFn;
};

const DEFAULT_MAX_MESSAGES = 40;

/** Prefix used to identify summary messages. Must match existing persisted data. */
export const SUMMARY_PREFIX = "Previous conversation summary:\n";

export async function compactHistory(
  history: HistoryMessage[],
  opts: CompactOptions = {},
): Promise<HistoryMessage[]> {
  const max = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxTokens = opts.maxTokens ?? 0;

  // Dual threshold: trigger on message count OR token budget
  const messageThresholdHit = history.length > max;
  const tokenThresholdHit =
    maxTokens > 0 && estimateHistoryTokens(history) > maxTokens;

  if (!messageThresholdHit && !tokenThresholdHit) return history;

  // Dynamic keep ratio based on pressure level
  const msgPressure = history.length / max;
  const tokenPressure =
    maxTokens > 0 ? estimateHistoryTokens(history) / maxTokens : 0;
  const pressure = Math.max(msgPressure, tokenPressure);

  const keepRatio = pressure > 2.0 ? 0.25 : pressure > 1.5 ? 0.5 : 0.75;
  const keep = Math.floor(max * keepRatio);
  const cutoff = history.length - keep;
  if (cutoff <= 0) return history;

  const early = history.slice(0, cutoff);
  const recent = history.slice(cutoff);

  console.log(
    `[compact] ${history.length} messages → trimming ${early.length} early, keeping ${recent.length} recent` +
      ` (pressure=${pressure.toFixed(2)}, keep=${Math.round(keepRatio * 100)}%)` +
      (tokenThresholdHit
        ? ` (tokens: ~${estimateHistoryTokens(history)}/${maxTokens})`
        : ""),
  );

  // --- Run memoryFlush + summarize in PARALLEL ---
  const memoryFlushPromise = opts.memoryFlush
    ? (async () => {
        try {
          const t0 = Date.now();
          // Skip summary message — only flush real conversation
          const flushMessages = isSummaryMessage(early[0])
            ? early.slice(1)
            : early;
          if (flushMessages.length > 0) {
            await opts.memoryFlush!(flushMessages);
          }
          console.log(`[compact] memoryFlush: ${Date.now() - t0}ms`);
        } catch {
          // Best-effort — do not block compaction
        }
      })()
    : Promise.resolve();

  const summarizePromise = opts.summarize
    ? (async (): Promise<string | null> => {
        try {
          const t0 = Date.now();
          let summary: string;

          if (isSummaryMessage(early[0])) {
            // INCREMENTAL MERGE: first message is an existing summary
            const existingSummary = early[0].content.slice(
              SUMMARY_PREFIX.length,
            );
            const newMessages = early.slice(1);
            summary = await mergeSummarize(
              existingSummary,
              newMessages,
              opts.summarize!,
            );
          } else {
            // FRESH SUMMARY: no prior summary exists
            summary = await opts.summarize!(early);
          }

          console.log(
            `[compact] summarize: ${Date.now() - t0}ms (${summary.length} chars)`,
          );
          return summary;
        } catch {
          return null; // Fallback to simple truncation
        }
      })()
    : Promise.resolve(null);

  const [, summary] = await Promise.all([memoryFlushPromise, summarizePromise]);

  if (summary) {
    return [
      { role: "system", content: `${SUMMARY_PREFIX}${summary}`, type: "summary" },
      ...recent,
    ];
  }

  return [
    { role: "system", content: `[Earlier ${early.length} messages omitted]`, type: "summary" },
    ...recent,
  ];
}

/** Check if a message is a compaction summary. */
function isSummaryMessage(msg: HistoryMessage | undefined): boolean {
  return (
    msg?.role === "system" && msg.content.startsWith(SUMMARY_PREFIX)
  );
}

/**
 * Merge an existing summary with new messages by calling summarize
 * with a merge-instruction prompt.
 */
async function mergeSummarize(
  existingSummary: string,
  newMessages: HistoryMessage[],
  summarize: SummarizeFn,
): Promise<string> {
  const formatted = newMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const mergeInstruction: HistoryMessage = {
    role: "user",
    content:
      `[MERGE TASK] Update the existing conversation summary by incorporating the new messages below.\n` +
      `Preserve all key facts, decisions, and context from the existing summary. Add new information from the new messages.\n` +
      `Be concise. Write in the same language as the content.\n\n` +
      `EXISTING SUMMARY:\n${existingSummary}\n\n` +
      `NEW MESSAGES:\n${formatted}`,
  };

  return summarize([mergeInstruction]);
}
