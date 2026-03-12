import type Database from "better-sqlite3";
import { encrypt, decrypt, deriveKey } from "../crypto.js";

/**
 * Blocked secret keys — these env vars control process/shell/linker behavior
 * and must never be overridden by user secrets.
 *
 * Layer 1: Exact keys — dangerous shell/runtime variables
 * Layer 2: Override-protected — safe to inherit but not to override
 * Layer 3: Prefix-based — library injection vectors
 */
const BLOCKED_KEYS = new Set([
  // Layer 1: Shell & runtime control
  "PATH", "HOME", "SHELL", "SHELLOPTS", "BASH_ENV", "ENV",
  "IFS", "PS4", "PROMPT_COMMAND", "HISTFILE",
  "NODE_OPTIONS", "NODE_PATH",
  "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP",
  "PERL5LIB", "PERL5OPT", "PERL5DB",
  "RUBYLIB", "RUBYOPT",
  // Layer 2: Override-protected — trust variables
  "EDITOR", "VISUAL", "PAGER",
  "GIT_SSH_COMMAND", "GIT_SSH", "GIT_PROXY_COMMAND",
  "GIT_ASKPASS", "GIT_EXTERNAL_DIFF",
  "SSH_ASKPASS", "SUDO_EDITOR",
  "LESSOPEN", "LESSCLOSE",
  "OPENSSL_CONF", "OPENSSL_ENGINES",
  "WGETRC", "CURL_HOME",
  "SSLKEYLOGFILE", "GCONV_PATH",
]);

const BLOCKED_PREFIXES = ["LD_", "DYLD_", "BASH_FUNC_", "GIT_CONFIG_", "NPM_CONFIG_"];

/** Returns a reason string if the key is blocked, or null if allowed. */
export function validateSecretKey(key: string): string | null {
  const upper = key.toUpperCase();
  if (BLOCKED_KEYS.has(upper)) {
    return `"${key}" is a protected environment variable and cannot be used as a secret key.`;
  }
  for (const prefix of BLOCKED_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return `Keys starting with "${prefix}" are blocked for security reasons.`;
    }
  }
  return null;
}

/**
 * Generic per-user secrets store (KV, AES-256-GCM encrypted).
 *
 * Table: user_secrets (user_id, key) → encrypted value
 */
const MAX_SECRETS_PER_USER = 20;
const CACHE_TTL_MS = 30 * 60_000; // 30 minutes

type CacheEntry = { data: Record<string, string>; expiresAt: number };

export class UserSecretsManager {
  private key: Buffer;
  private cache = new Map<string, CacheEntry>();

  constructor(
    private db: Database.Database,
    secretKey: string,
  ) {
    this.key = deriveKey(secretKey);
  }

  /** Invalidate cache for a user (called on write/delete). */
  private invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** Store (or overwrite) a secret for the given user. Throws if key is blocked or limit reached. */
  set(userId: string, key: string, plaintext: string): void {
    const blocked = validateSecretKey(key);
    if (blocked) throw new Error(blocked);

    // Check limit (only for new keys, not updates)
    const existing = this.db
      .prepare<[string, string], { key: string }>(
        "SELECT key FROM user_secrets WHERE user_id = ? AND key = ?",
      )
      .get(userId, key);
    if (!existing) {
      const count = this.db
        .prepare<[string], { cnt: number }>(
          "SELECT COUNT(*) as cnt FROM user_secrets WHERE user_id = ?",
        )
        .get(userId);
      if ((count?.cnt ?? 0) >= MAX_SECRETS_PER_USER) {
        throw new Error(`Secret limit reached (max ${MAX_SECRETS_PER_USER}). Delete unused secrets first.`);
      }
    }

    const encrypted = encrypt(plaintext, this.key);
    this.db
      .prepare(
        `INSERT INTO user_secrets (user_id, key, value, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(userId, key, encrypted);
    this.invalidate(userId);
  }

  /** Retrieve and decrypt a secret. Returns null if not found. */
  get(userId: string, key: string): string | null {
    const row = this.db
      .prepare<[string, string], { value: string }>(
        "SELECT value FROM user_secrets WHERE user_id = ? AND key = ?",
      )
      .get(userId, key);
    if (!row) return null;
    return decrypt(row.value, this.key);
  }

  /** Delete a secret. */
  delete(userId: string, key: string): boolean {
    const result = this.db
      .prepare("DELETE FROM user_secrets WHERE user_id = ? AND key = ?")
      .run(userId, key);
    this.invalidate(userId);
    return result.changes > 0;
  }

  /** Retrieve and decrypt all secrets for a user as a key→value map. Skips blocked keys. Cached for 30s. */
  getAllDecrypted(userId: string): Record<string, string> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const rows = this.db
      .prepare<[string], { key: string; value: string }>(
        "SELECT key, value FROM user_secrets WHERE user_id = ?",
      )
      .all(userId);
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (validateSecretKey(row.key)) continue; // skip blocked (legacy data)
      result[row.key] = decrypt(row.value, this.key);
    }
    this.cache.set(userId, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  }

  /** List all secret keys (not values) for a user. */
  listKeys(userId: string): string[] {
    const rows = this.db
      .prepare<[string], { key: string }>(
        "SELECT key FROM user_secrets WHERE user_id = ? ORDER BY key",
      )
      .all(userId);
    return rows.map((r) => r.key);
  }
}
