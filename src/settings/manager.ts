import type Database from "better-sqlite3";

export class UserSettingsManager {
  constructor(private db: Database.Database) {}

  getCustomPrompt(userId: string): string | null {
    const row = this.db
      .prepare<[string], { custom_prompt: string | null }>(
        "SELECT custom_prompt FROM user_settings WHERE user_id = ?",
      )
      .get(userId);
    return row?.custom_prompt ?? null;
  }

  setCustomPrompt(userId: string, prompt: string): void {
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, custom_prompt, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET custom_prompt = excluded.custom_prompt, updated_at = excluded.updated_at`,
      )
      .run(userId, prompt);
  }

  clearCustomPrompt(userId: string): void {
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, custom_prompt, updated_at)
         VALUES (?, NULL, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET custom_prompt = NULL, updated_at = excluded.updated_at`,
      )
      .run(userId);
  }
}
