import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  WORKSPACE_DIR: z.string().default("."),

  // Fault healing (optional — only needed for Sentry/Lark pipeline)
  ANTHROPIC_API_KEY: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
  LARK_APP_ID: z.string().optional(),
  LARK_APP_SECRET: z.string().optional(),
  LARK_NOTIFY_CHAT_ID: z.string().optional(),
  GH_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(),

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
