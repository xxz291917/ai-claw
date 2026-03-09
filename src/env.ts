import { z } from "zod";
import { resolve } from "node:path";

const envSchema = z.object({
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PORT: z.coerce.number().default(8080),
  WORKSPACE_DIR: z.string().default("data/workspace").transform((p) => resolve(p)),

  // AI providers — Claude
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  CLAUDE_MODEL: z.string().optional(),
  CLAUDE_MAX_TURNS: z.coerce.number().optional(),
  CLAUDE_MAX_BUDGET_USD: z.coerce.number().optional(),
  GH_TOKEN: z.string().optional(),

  // Sentry tool (optional — enables sentry_query tool for Chat)
  SENTRY_BASE_URL: z.string().default("https://sentry.io"),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),

  // Web tools (optional)
  BRAVE_API_KEY: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),

  // Bash exec tool
  BASH_EXEC_ENABLED: z.enum(["true", "false"]).default("true"),
  BASH_EXEC_TIMEOUT: z.coerce.number().default(120),
  BASH_EXEC_MAX_TIMEOUT: z.coerce.number().default(600),
  BASH_EXEC_ALLOWED_COMMANDS: z
    .string()
    .default(
      "git,gh,npm,node,curl,jq,ssh,sqlite3,pm2,make,claude,codex," +
        "ls,cat,head,tail,grep,rg,find,wc,sort,cut,tr,awk,sed,diff," +
        "echo,date,pwd,which,whoami,uname,basename,dirname,mkdir,cp,mv,touch,chmod,rm,tar,tee,xargs," +
        "docker,python,python3,pip",
    ),

  // Skills (extra directories for ClawHub-installed skills, comma-separated)
  SKILLS_EXTRA_DIRS: z.string().default("skills_extra"),

  // Chat assistant
  CHAT_PROVIDER: z.string().default("claude"),
  CHAT_MODEL: z.string().optional(),
  CHAT_API_BASE: z.string().optional(),
  CHAT_API_KEY: z.string().optional(),
  CHAT_USERS: z.string().optional(),
  CHAT_MAX_TOOL_RESULT_CHARS: z.coerce.number().default(4000),
  CHAT_MAX_CONTEXT_TOKENS: z.coerce.number().default(60000),
  CHAT_FETCH_TIMEOUT: z.coerce.number().default(120),
  /** Max estimated tokens before triggering history compaction. 0 = disabled (message count only). */
  CHAT_MAX_HISTORY_TOKENS: z.coerce.number().default(0),

  // Lark bot (optional — enables POST /api/lark/webhook)
  LARK_APP_ID: z.string().optional(),
  LARK_APP_SECRET: z.string().optional(),
  LARK_VERIFICATION_TOKEN: z.string().optional(),
  LARK_ENCRYPT_KEY: z.string().optional(),
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
