import { z } from "zod";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  SENTRY_AUTH_TOKEN: z.string().min(1),
  SENTRY_ORG: z.string().min(1),
  SENTRY_PROJECT: z.string().min(1),
  LARK_APP_ID: z.string().min(1),
  LARK_APP_SECRET: z.string().min(1),
  LARK_NOTIFY_CHAT_ID: z.string().min(1),
  GH_TOKEN: z.string().min(1),
  GITHUB_REPO: z.string().min(1),
  PORT: z.coerce.number().default(8080),
  WORKSPACE_DIR: z.string().min(1),

  // Chat assistant
  CHAT_PROVIDER: z.enum(["claude", "generic"]).default("claude"),
  CHAT_MODEL: z.string().optional(),
  CHAT_API_BASE: z.string().optional(),
  CHAT_API_KEY: z.string().optional(),
  CHAT_SYSTEM_PROMPT: z
    .string()
    .default(
      "You are a helpful engineering assistant. You have access to code tools (bash, read, write, edit, grep, glob) and can help with any engineering task.",
    ),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;
  _env = envSchema.parse(process.env);
  return _env;
}

/** For testing: inject env without parsing process.env */
export function setEnv(env: Env): void {
  _env = env;
}
