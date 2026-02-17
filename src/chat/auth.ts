/**
 * Parse CHAT_USERS env var into Map<token, userId>.
 * Format: "name:token,name:token"
 * Returns empty map if input is undefined or empty.
 */
export function parseChatUsers(
  raw: string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;

  for (const entry of raw.split(",")) {
    const colonIdx = entry.indexOf(":");
    if (colonIdx <= 0) continue;
    const name = entry.slice(0, colonIdx).trim();
    const token = entry.slice(colonIdx + 1).trim();
    if (name && token) {
      map.set(token, name);
    }
  }
  return map;
}
