import type { MiddlewareHandler } from "hono";

// Augment Hono's context variables
declare module "hono" {
  interface ContextVariableMap {
    userId: string;
  }
}

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

/**
 * Hono middleware for chat auth.
 * - Empty users map → anonymous mode (userId = "web-anonymous")
 * - Non-empty users map → require Bearer token, resolve userId
 */
export function chatAuthMiddleware(
  users: Map<string, string>,
): MiddlewareHandler {
  return async (c, next) => {
    if (users.size === 0) {
      c.set("userId", "web-anonymous");
      return next();
    }

    const authHeader = c.req.header("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Authorization required" }, 401);
    }

    const token = authHeader.slice(7);
    const userId = users.get(token);
    if (!userId) {
      return c.json({ error: "Invalid token" }, 401);
    }

    c.set("userId", userId);
    return next();
  };
}
