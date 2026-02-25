/**
 * Skill eligibility checker.
 *
 * Determines whether a skill's runtime dependencies (env vars, binaries) are
 * satisfied in the current environment.
 */

import { execFileSync } from "node:child_process";
import type { SkillMetadata } from "./frontmatter.js";

export type SkillRequirements = { env: string[]; bins: string[] };

export type EligibilityResult = {
  eligible: boolean;
  missingEnv: string[];
  missingBins: string[];
};

/**
 * Normalize a value to a string array.
 * - string → split by comma, trim each element, drop blanks
 * - string[] → returned as-is
 * - undefined / null → []
 */
export function toStringArray(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Extract skill requirements from parsed frontmatter metadata.
 * Reads `requires-env` and `requires-bins` fields.
 */
export function extractRequirements(
  metadata: SkillMetadata | null,
): SkillRequirements {
  if (!metadata) return { env: [], bins: [] };

  const raw = metadata as Record<string, unknown>;
  return {
    env: toStringArray(raw["requires-env"] as string | string[] | undefined),
    bins: toStringArray(raw["requires-bins"] as string | string[] | undefined),
  };
}

/**
 * Check whether a binary is available on the system PATH.
 */
export function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether all requirements are satisfied.
 *
 * @param reqs      - The requirements to check.
 * @param envLookup - Custom env-var lookup (defaults to `process.env`).
 * @param binLookup - Custom binary lookup (defaults to `hasBinary`).
 */
export function checkEligibility(
  reqs: SkillRequirements,
  envLookup: (key: string) => string | undefined = (key) => process.env[key],
  binLookup: (name: string) => boolean = hasBinary,
): EligibilityResult {
  const missingEnv = reqs.env.filter((key) => !envLookup(key));
  const missingBins = reqs.bins.filter((name) => !binLookup(name));

  return {
    eligible: missingEnv.length === 0 && missingBins.length === 0,
    missingEnv,
    missingBins,
  };
}

/**
 * Format an eligibility result into a human-readable reason string.
 * Returns an empty string when nothing is missing.
 */
export function formatMissingReason(result: EligibilityResult): string {
  const parts: string[] = [];

  if (result.missingEnv.length > 0) {
    parts.push(`Missing env: ${result.missingEnv.join(", ")}`);
  }
  if (result.missingBins.length > 0) {
    parts.push(`Missing binary: ${result.missingBins.join(", ")}`);
  }

  return parts.join("; ");
}
