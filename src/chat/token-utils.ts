/**
 * Shared token estimation utilities.
 *
 * CJK chars ≈ 1 token each, other chars ≈ 1 token per 4 chars.
 * Good enough for budget tracking — not meant for billing precision.
 */

export function estimateStringTokens(s: string): number {
  let tokens = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Punctuation
      (code >= 0xff00 && code <= 0xffef)    // Fullwidth Forms
    ) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/**
 * Estimate total tokens for a simple message array (role + content only).
 */
export function estimateHistoryTokens(
  messages: Array<{ content: string }>,
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateStringTokens(m.content);
  }
  return total;
}
