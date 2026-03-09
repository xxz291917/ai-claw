import { basename } from "node:path";

/**
 * Sensitive file patterns — shared by file_read/file_write (safePath) and bash_exec.
 * Blocks access to secrets, credentials, and private keys.
 */
export const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env($|\.)/, // .env, .env.local, .env.production, etc.
  /^\.netrc$/,
  /^\.npmrc$/,
  /^credentials\.json$/i,
  /^secrets?\./i,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
];

/** Check if a file path (or basename) matches a sensitive pattern */
export function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);
  return SENSITIVE_PATTERNS.some((p) => p.test(name));
}
