/**
 * ClawHub registry client — fetch, install, uninstall, and search skills
 * from the public ClawHub registry (https://clawhub.ai).
 *
 * All read/download operations are unauthenticated.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import AdmZip from "adm-zip";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAWHUB_BASE = "https://clawhub.ai";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SKILL_BYTES = 200_000; // registry limit
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000; // 1s, 2s, 4s exponential backoff

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillMeta = {
  slug: string;
  name: string;
  description: string;
  latestTag: string;
  author?: string;
};

export type SearchResult = {
  slug: string;
  name: string;
  description: string;
  tags?: string[];
};

export type LockEntry = {
  slug: string;
  tag: string;
  installedAt: string;
};

export type LockFile = {
  version: 1;
  skills: Record<string, LockEntry>;
};

// ---------------------------------------------------------------------------
// Retry helper (handles 429 rate-limit)
// ---------------------------------------------------------------------------

async function fetchRetry(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      ...init,
    });
    if (res.status !== 429) return res;
    // Exponential backoff: 1s, 2s, 4s
    const delay = RETRY_BASE_MS * 2 ** attempt;
    await new Promise((r) => setTimeout(r, delay));
  }
  // Final attempt — return whatever we get
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...init });
}

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

/** GET /api/v1/skills/{slug} — skill metadata + latest version */
export async function fetchSkillMeta(slug: string): Promise<SkillMeta> {
  validateSlug(slug);
  const res = await fetchRetry(
    `${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}`,
  );
  if (res.status === 404) {
    throw new Error(`Skill "${slug}" not found in ClawHub registry`);
  }
  if (!res.ok) {
    throw new Error(`ClawHub API error: ${res.status} ${res.statusText}`);
  }
  const data: any = await res.json();
  return {
    slug: data.slug ?? slug,
    name: data.name ?? data.displayName ?? slug,
    description: data.description ?? data.summary ?? "",
    latestTag: data.latestVersion?.version ?? data.latest_tag ?? "latest",
    author: data.author ?? data.owner,
  };
}

/** GET /api/v1/skills/{slug}/file?path=SKILL.md&tag=... — raw content */
export async function fetchSkillContent(
  slug: string,
  tag: string = "latest",
): Promise<string> {
  validateSlug(slug);
  const params = new URLSearchParams({ path: "SKILL.md", tag });
  const res = await fetchRetry(
    `${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}/file?${params}`,
  );
  if (res.status === 404) {
    throw new Error(`SKILL.md for "${slug}@${tag}" not found`);
  }
  if (!res.ok) {
    throw new Error(`ClawHub API error: ${res.status} ${res.statusText}`);
  }
  const content = await res.text();
  if (content.length > MAX_SKILL_BYTES) {
    throw new Error(`Skill content exceeds ${MAX_SKILL_BYTES} byte limit`);
  }
  return content;
}

/** GET /api/v1/search?q={query} — full-text search */
export async function searchSkills(query: string): Promise<SearchResult[]> {
  if (!query.trim()) throw new Error("Search query cannot be empty");
  const params = new URLSearchParams({ q: query.trim() });
  const res = await fetchRetry(`${CLAWHUB_BASE}/api/v1/search?${params}`);
  if (!res.ok) {
    throw new Error(`ClawHub search error: ${res.status} ${res.statusText}`);
  }
  const data: any = await res.json();
  const results: any[] = data.results ?? data.skills ?? data ?? [];
  return results.slice(0, 10).map((r: any) => ({
    slug: r.slug ?? r.name ?? "",
    name: r.name ?? r.displayName ?? r.slug ?? "",
    description: r.description ?? r.summary ?? "",
    tags: r.tags,
  }));
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

/** GET /api/v1/download?slug={slug}&tag={tag} — full zip package */
async function fetchSkillZip(slug: string, tag: string): Promise<Buffer> {
  const params = new URLSearchParams({
    slug: encodeURIComponent(slug),
    tag: encodeURIComponent(tag),
  });
  const res = await fetchRetry(`${CLAWHUB_BASE}/api/v1/download?${params}`);
  if (res.status === 404) {
    throw new Error(`Skill "${slug}@${tag}" not found for download`);
  }
  if (!res.ok) {
    throw new Error(`ClawHub download error: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Install a skill from ClawHub registry.
 * Downloads the full zip package and extracts all files into installDir/<slug>/.
 * Updates the lockfile. Returns the installed tag.
 */
export async function installSkill(
  installDir: string,
  slug: string,
): Promise<{ tag: string; alreadyInstalled: boolean }> {
  validateSlug(slug);
  const skillDir = safeSkillPath(installDir, slug);

  const lock = readLockFile(installDir);
  const meta = await fetchSkillMeta(slug);
  const tag = meta.latestTag;

  if (lock.skills[slug]?.tag === tag) {
    return { tag, alreadyInstalled: true };
  }

  const zipBuf = await fetchSkillZip(slug, tag);
  const zip = new AdmZip(zipBuf);

  // Clear target dir to remove stale files from previous versions
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });

  const resolvedSkillDir = resolve(skillDir);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    // Skip ClawHub internal metadata
    if (name === "_meta.json") continue;
    // Zip slip protection: reject paths with ".."
    if (name.includes("..")) continue;

    const target = resolve(skillDir, name);
    // Zip slip protection: ensure target stays within skillDir
    if (!target.startsWith(resolvedSkillDir + "/")) continue;

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.getData());
  }

  lock.skills[slug] = { slug, tag, installedAt: new Date().toISOString() };
  writeLockFile(installDir, lock);

  return { tag, alreadyInstalled: false };
}

/** Remove installDir/<slug>/ and its lockfile entry. */
export function uninstallSkill(installDir: string, slug: string): void {
  validateSlug(slug);
  const skillDir = safeSkillPath(installDir, slug);

  if (!existsSync(skillDir)) {
    throw new Error(`Skill "${slug}" is not installed`);
  }

  rmSync(skillDir, { recursive: true, force: true });

  const lock = readLockFile(installDir);
  delete lock.skills[slug];
  writeLockFile(installDir, lock);
}

// ---------------------------------------------------------------------------
// Lockfile (compatible with ClawHub CLI format)
// ---------------------------------------------------------------------------

export function readLockFile(installDir: string): LockFile {
  const path = join(installDir, ".clawhub", "lock.json");
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return { version: 1, skills: parsed.skills ?? {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

function writeLockFile(installDir: string, lock: LockFile): void {
  const dir = join(installDir, ".clawhub");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lock.json"), JSON.stringify(lock, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/** Validate slug: alphanumeric + hyphens + underscores, 1-64 chars. */
export function validateSlug(slug: string): void {
  if (!slug || !/^[a-zA-Z0-9_-]{1,64}$/.test(slug)) {
    throw new Error(
      `Invalid skill slug: "${slug}". Must be 1-64 alphanumeric/hyphen/underscore characters.`,
    );
  }
}

/** Compute skill dir path and verify it stays within installDir. */
export function safeSkillPath(installDir: string, slug: string): string {
  const skillDir = resolve(installDir, slug);
  if (!skillDir.startsWith(installDir + "/")) {
    throw new Error(`Skill path escapes install directory: ${slug}`);
  }
  return skillDir;
}
