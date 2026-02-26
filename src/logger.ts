const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

export const log = {
  debug: (...args: unknown[]) => {
    if (threshold() <= LEVELS.debug) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (threshold() <= LEVELS.info) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (threshold() <= LEVELS.warn) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    console.error(...args);
  },
};
